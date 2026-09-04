import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import type { AXNode } from './cdp-service.js';

const CREDENTIAL = 'synthetic-secret-do-not-return';

function element(type: string) {
  return {
    tagName: type === 'submit' ? 'BUTTON' : 'INPUT',
    type,
    value: '',
    isConnected: true,
    readOnly: false,
    nativeDisabled: false,
    ariaDisabled: false,
    autofilled: type !== 'submit',
    matches(selector: string) {
      if (selector === ':disabled') return this.nativeDisabled;
      if (selector === ':-webkit-autofill' || selector === ':autofill') return this.autofilled;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    closest(selector: string) {
      assert.equal(selector, '[aria-disabled="true"]');
      return this.ariaDisabled ? this : null;
    },
    getAttribute(name: string) {
      return name === 'aria-readonly' && this.readOnly ? 'true' : null;
    },
    scrollIntoView() {},
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 40 }; },
  };
}

async function fixture(t: test.TestContext) {
  const elements = [element('email'), element('password'), element('submit')];
  elements[2].nativeDisabled = true;
  const mouseEvents: any[] = [];
  const probeResponses: unknown[] = [];
  const released: string[] = [];
  let failure = false;
  const nodes: AXNode[] = [
    { nodeId: 'root', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: ['0', '1', '2'] },
    ...['Email', 'Password', 'Sign in'].map((name, index) => ({
      nodeId: String(index), ignored: false, backendDOMNodeId: index + 1,
      role: { type: 'role', value: index === 2 ? 'button' : 'textbox' },
      name: { type: 'string', value: name },
      value: { type: 'string', value: CREDENTIAL },
      childIds: index === 1 ? ['secret-child'] : [],
    })),
    { nodeId: 'secret-child', ignored: false, role: { type: 'role', value: 'StaticText' }, name: { type: 'string', value: CREDENTIAL } },
  ];
  const stored: Record<string, unknown> = {};
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  (globalThis as any).chrome = {
    storage: { session: { get: async () => stored, set: async (value: object) => Object.assign(stored, value) } },
    debugger: {
      attach: async () => {}, detach: async () => {},
      sendCommand: async (_target: unknown, method: string, params: any = {}) => {
        if (method.endsWith('.enable')) return {};
        if (method === 'Accessibility.getFullAXTree') return { nodes };
        if (method === 'DOM.resolveNode') {
          if (failure) throw new Error(CREDENTIAL);
          return { object: { objectId: String(params.backendNodeId) } };
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = runInNewContext(`(${params.functionDeclaration})`);
          const result = fn.apply(elements[Number(params.objectId) - 1], params.arguments?.map((arg: any) => arg.value) ?? []);
          probeResponses.push(result);
          return { result: { value: result } };
        }
        if (method === 'Runtime.releaseObject') { released.push(params.objectId); return {}; }
        if (method === 'DOM.getContentQuads') return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
        if (method === 'Input.dispatchMouseEvent') { mouseEvents.push(params); return {}; }
        throw new Error(`Unexpected CDP method: ${method}`);
      },
    },
  };
  const dom = await import('./cdp-dom-service.js');
  const cdp = await import('./cdp-service.js');
  t.after(async () => { dom.cleanupTab(42); await cdp.detach(42); delete (globalThis as any).chrome; });
  return { dom, elements, mouseEvents, probeResponses, released, stored, fail: () => { failure = true; } };
}

test('snapshot distinguishes pending autofill and ready form without exposing credential values', async t => {
  const f = await fixture(t);
  const before = await f.dom.getSnapshot(42, { interactive: true });
  assert.match(before.snapshot, /textbox "Email".*\[value=empty\].*\[autofill\]/);
  assert.match(before.snapshot, /button "Sign in".*\[disabled\]/);
  f.elements[0].value = CREDENTIAL;
  f.elements[1].value = CREDENTIAL;
  f.elements[2].nativeDisabled = false;
  const after = await f.dom.getSnapshot(42);
  assert.match(after.snapshot, /textbox "Password".*\[value=present\]/);
  assert.match(after.snapshot, /button "Sign in".*\[enabled\]/);
  assert.notEqual(before.snapshot, after.snapshot);
  assert.ok(!JSON.stringify([before, after, f.probeResponses, f.stored]).includes(CREDENTIAL));
  assert.ok(f.released.length >= 6, 'state probes must release temporary remote objects');
  assert.deepEqual(f.mouseEvents, [], 'snapshot never activates autofill or submits');
});

test('unreadable form state is unknown, not empty or enabled, and does not leak probe errors', async t => {
  const f = await fixture(t);
  f.fail();
  const snapshot = await f.dom.getSnapshot(42, { interactive: true });
  assert.match(snapshot.snapshot, /textbox "Password".*\[value=unknown\]/);
  assert.match(snapshot.snapshot, /button "Sign in".*\[disabled=unknown\]/);
  assert.ok(!JSON.stringify(snapshot).includes(CREDENTIAL));
});

test('snapshot reports native and ARIA disabling plus readonly fields', async t => {
  const f = await fixture(t);
  f.elements[0].readOnly = true;
  f.elements[2].nativeDisabled = false;
  f.elements[2].ariaDisabled = true;
  const snapshot = await f.dom.getSnapshot(42, { interactive: true });
  assert.match(snapshot.snapshot, /textbox "Email".*\[readonly\]/);
  assert.match(snapshot.snapshot, /button "Sign in".*\[disabled\]/);
});

test('click refuses a currently disabled button even when its snapshot was enabled', async t => {
  const f = await fixture(t);
  f.elements[2].nativeDisabled = false;
  const snapshot = await f.dom.getSnapshot(42, { interactive: true });
  const ref = Object.entries(snapshot.refs).find(([, info]) => info.name === 'Sign in')![0];
  f.elements[2].nativeDisabled = true;
  await assert.rejects(f.dom.clickElement(42, ref), /disabled/i);
  assert.deepEqual(f.mouseEvents, []);
  f.elements[2].nativeDisabled = false;
  await f.dom.clickElement(42, ref);
  assert.deepEqual(f.mouseEvents.map(event => event.type), ['mousePressed', 'mouseReleased']);
});

test('click fails closed when live interactability cannot be checked', async t => {
  const f = await fixture(t);
  const snapshot = await f.dom.getSnapshot(42, { interactive: true });
  const ref = Object.entries(snapshot.refs).find(([, info]) => info.name === 'Sign in')![0];
  f.fail();
  await assert.rejects(f.dom.clickElement(42, ref), error => error instanceof Error && !error.message.includes(CREDENTIAL));
  assert.deepEqual(f.mouseEvents, []);
});
