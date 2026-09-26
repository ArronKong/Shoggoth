import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../app/manage-ui/package.json', import.meta.url));
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
const file = new URL('../app/manage-ui/src/pages/InspirationCapture.tsx', import.meta.url);
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file.pathname, compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ scale = 1, naturalHeight = 210 } = {}) {
  let renderer, disabled = false;
  const observers = new Set(), captures = new Set(), listeners = new Map();
  const height = () => renderer?.root.findByType('section').props.style?.height ?? naturalHeight;
  const section = { getBoundingClientRect: () => ({ height: height() * scale }) };
  const handle = { focus() {}, setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
  const mod = { exports: {} };
  vm.runInNewContext(code, { exports: mod.exports,
    require: name => name.endsWith('.css') ? {} : name === 'react-i18next' ? { useTranslation: () => ({ t: key => key }) } : require(name),
    getComputedStyle: () => ({ height: `${height()}px` }),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
  });
  const children = React.createElement('textarea', { defaultValue: 'Keep this draft while resizing.' });
  const render = () => React.createElement(mod.exports.default, { disabled }, children);
  act(() => { renderer = create(render(), { createNodeMock: node => node.type === 'section' ? section : handle }); });
  const measure = () => act(() => observers.forEach(observer => observer.callback()));
  const button = () => renderer.root.findByType('button');
  const pointer = (name, y = 100, props = {}) => {
    const event = { clientY: y, pointerId: 1, button: 0, isPrimary: true, currentTarget: handle, preventDefault() {}, ...props };
    act(() => button().props[name](event)); measure();
  };
  const key = (key, shiftKey = false) => {
    let prevented = false;
    act(() => button().props.onKeyDown({ key, shiftKey, preventDefault() { prevented = true; } })); measure();
    return prevented;
  };
  return { height, pointer, key, button, captures, observers, listeners, renderer,
    resizing: () => Boolean(renderer.root.findByType('section').props['data-inspiration-resizing']),
    disable: () => act(() => { disabled = true; renderer.update(render()); }),
    blur: () => act(() => listeners.get('blur')()),
    close: () => act(() => renderer.unmount()),
  };
}

for (const scale of [1, .5]) {
  const f = fixture({ scale });
  f.pointer('onPointerDown');
  assert.equal(f.captures.has(1), true, 'the bottom edge captures the pointer outside its hit area');
  f.pointer('onPointerMove', 100 + 90 * scale);
  assert.equal(f.height(), 300, 'visible dragging follows the pointer at the printer scale');
  assert.equal(f.button().props['aria-valuenow'], 300);
  f.pointer('onPointerDown', 100, { pointerId: 2 });
  f.pointer('onPointerMove', 900, { pointerId: 2 });
  f.pointer('onPointerUp', 900, { pointerId: 2 });
  assert.equal(f.height(), 300, 'additional pointers cannot move or finish the first gesture');
  assert.equal(f.resizing(), true);
  f.pointer('onPointerMove', 1200);
  assert.equal(f.height(), 460, 'pulling past the bottom caps the entire note at 460px');
  f.pointer('onPointerMove', -1200);
  assert.equal(f.height(), 210, 'dragging upward stops at the default paper height');
  f.pointer('onPointerUp', 100 + 130 * scale);
  assert.equal(f.height(), 340, 'release applies the final pointer position');
  assert.equal(f.captures.size, 0);
  assert.equal(f.resizing(), false);
  assert.equal(f.renderer.root.findByType('textarea').props.defaultValue, 'Keep this draft while resizing.');
  f.close();
  assert.equal(f.observers.size, 0); assert.equal(f.listeners.size, 0);
}

{
  const f = fixture({ naturalHeight: 330 });
  f.pointer('onPointerDown'); f.pointer('onPointerMove', 150);
  assert.equal(f.height(), 380, 'drag starts from the content-grown height without a jump');
  f.key('Escape');
  assert.equal(f.height(), 330, 'Escape restores the height at the start of the gesture');
  assert.equal(f.captures.size, 0);
  f.key('ArrowDown'); assert.equal(f.height(), 346);
  f.key('ArrowUp', true); assert.equal(f.height(), 282);
  f.key('End'); assert.equal(f.height(), 460);
  f.key('Home'); assert.equal(f.height(), 210);
  assert.equal(f.key('Tab'), false, 'normal keyboard navigation is preserved');
  f.close();
}

for (const reason of ['onPointerCancel', 'onLostPointerCapture', 'blur', 'disabled', 'unmount']) {
  const f = fixture();
  f.pointer('onPointerDown', 100, { button: 2 });
  f.pointer('onPointerDown', 100, { isPrimary: false });
  assert.equal(f.resizing(), false, 'only the primary left pointer starts resizing');
  f.pointer('onPointerDown'); f.pointer('onPointerMove', 200);
  if (reason === 'blur') f.blur();
  else if (reason === 'disabled') f.disable();
  else if (reason === 'unmount') f.close();
  else f.pointer(reason);
  assert.equal(f.captures.size, 0, `${reason} releases pointer ownership`);
  if (reason !== 'unmount') {
    f.pointer('onPointerMove', 800);
    assert.equal(f.height(), 310, `${reason} ends the gesture without losing its size`);
    if (reason === 'disabled') {
      f.pointer('onPointerDown'); f.key('End');
      assert.equal(f.resizing(), false); assert.equal(f.height(), 310, 'saving and printing lock resizing');
    }
    f.close();
  }
}
console.log('PASS Inspiration capture resize: 210–460px bounds, scaled dragging, pointer capture, multiple pointers, release, cancellation, keyboard, busy state and cleanup');
