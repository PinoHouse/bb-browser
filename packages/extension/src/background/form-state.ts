import * as cdp from './cdp-service';

export interface FormState {
  disabled?: boolean;
  readOnly?: boolean;
  valueState?: 'empty' | 'present' | 'unknown';
  autofilled?: boolean;
}

export const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
export const FORM_ROLES = new Set([
  ...VALUE_ROLES, 'button', 'checkbox', 'radio', 'switch', 'listbox', 'slider',
]);

// Runs in the page. Never return the value, its length, or an exception detail.
// Keep this self-contained: the function is serialized across the CDP boundary.
function probeFormState(this: HTMLElement, includeValue: boolean): FormState {
  if (!this.isConnected) return {};
  const state: FormState = {};
  try {
    state.disabled = this.matches(':disabled') || this.closest('[aria-disabled="true"]') !== null;
    state.readOnly = (this as HTMLInputElement).readOnly === true || this.getAttribute('aria-readonly') === 'true';
  } catch { /* Unknown is not enabled. */ }
  if (includeValue) {
    state.valueState = 'unknown';
    try {
      // Do not inspect custom framework state or contenteditable text.
      if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') {
        const value = (this as HTMLInputElement).value;
        if (typeof value === 'string') state.valueState = value.length > 0 ? 'present' : 'empty';
      }
    } catch { /* Page getters can throw; do not expose their messages. */ }
    try {
      state.autofilled = this.matches(':-webkit-autofill');
    } catch { /* Unsupported selector means detection is unavailable. */ }
  }
  return state;
}

export async function readFormState(
  tabId: number,
  locator: { backendDOMNodeId?: number; xpath?: string },
  includeValue: boolean,
): Promise<FormState> {
  let objectId: string | undefined;
  try {
    let result: unknown;
    if (locator.backendDOMNodeId !== undefined) {
      objectId = await cdp.resolveNodeByBackendId(tabId, locator.backendDOMNodeId);
      if (!objectId) return {};
      result = await cdp.callFunctionOn(tabId, objectId, probeFormState.toString(), [includeValue]);
    } else if (locator.xpath) {
      result = await cdp.evaluate(tabId, `(() => {
        const element = document.evaluate(${JSON.stringify(locator.xpath)}, document, null,
          XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return element ? (${probeFormState.toString()}).call(element, ${includeValue}) : {};
      })()`, { returnByValue: true });
    }
    if (!result || typeof result !== 'object') return {};
    // Only these safe flags may leave this boundary, including malformed results.
    const state = result as FormState;
    return {
      disabled: typeof state.disabled === 'boolean' ? state.disabled : undefined,
      readOnly: typeof state.readOnly === 'boolean' ? state.readOnly : undefined,
      valueState: state.valueState === 'empty' || state.valueState === 'present' ? state.valueState : 'unknown',
      autofilled: typeof state.autofilled === 'boolean' ? state.autofilled : undefined,
    };
  } catch {
    return {};
  } finally {
    if (objectId) {
      try {
        await cdp.sendCommand(tabId, 'Runtime.releaseObject', { objectId });
      } catch { /* Navigation/disconnect may already have released it. */ }
    }
  }
}

export async function collectFormStates(tabId: number, nodes: cdp.AXNode[]): Promise<Map<number, FormState>> {
  const candidates = nodes.filter(node => !node.ignored && node.backendDOMNodeId !== undefined && FORM_ROLES.has(node.role?.value ?? ''));
  const states = new Map<number, FormState>();
  // Bound concurrent CDP probes; no interaction or autofill activation here.
  for (let offset = 0; offset < candidates.length; offset += 8) {
    await Promise.all(candidates.slice(offset, offset + 8).map(async node => {
      const state = await readFormState(tabId, node, VALUE_ROLES.has(node.role?.value ?? ''));
      states.set(node.backendDOMNodeId!, state);
    }));
  }
  return states;
}
