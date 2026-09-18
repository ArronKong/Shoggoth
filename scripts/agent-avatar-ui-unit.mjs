import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import avatarModule from "./helpers/load-agent-avatar.cjs";

const require = createRequire(path.resolve("app/manage-ui/package.json"));
const React = require("react");
const { create, act } = require("react-test-renderer");
const AgentAvatar = avatarModule.default;
let renderer;
let cachedImage = null;
const show = props => act(() => {
  const element = React.createElement(AgentAvatar, props);
  if (renderer) renderer.update(element);
  else renderer = create(element, { createNodeMock: node => node.type === "img" ? cachedImage : null });
});
const avatar = () => renderer.root.findByType("span");
const image = () => renderer.root.findByType("img");
const state = () => avatar().props["data-avatar-state"];
const succeed = () => act(() => image().props.onLoad());
const fail = () => act(() => image().props.onError());

show({ agentId: "stable/id", name: "中文助理", className: "page-avatar", loading: "lazy" });
assert.equal(image().props.src, "/avatar/stable%2Fid");
assert.equal(image().props.loading, "lazy");
assert.equal(state(), "loading");
assert.equal(avatar().props["data-initial"], "中");
const texture = avatar().props.style["--ui-agent-avatar-bg"];
succeed();
assert.equal(state(), "loaded");
assert.equal(avatar().props.style.background, "transparent", "loaded images cannot reveal the fallback background at edges or through alpha");
assert.equal(avatar().props["data-initial"], undefined, "no monogram is left behind a transparent image");
assert.match(avatar().props.className, /page-avatar/);
show({ agentId: "stable/id", name: "Renamed" });
assert.equal(state(), "loaded", "renaming does not flash or reload the same image");

show({ agentId: "missing", name: "Missing" });
assert.equal(state(), "loading");
fail();
assert.equal(state(), "fallback");
assert.equal(renderer.root.findAllByType("img").length, 0, "broken image icon is removed");
assert.equal(avatar().props["data-initial"], "M");
assert.notEqual(avatar().props.style.background, "transparent");
show({ agentId: "missing", name: "Missing", version: 2 });
assert.equal(state(), "loading", "an upload or external refresh retries a failed image");
assert.equal(image().props.src, "/avatar/missing?v=2");
succeed();

show({ agentId: "stable/id", name: "中文助理" });
assert.equal(state(), "loading", "switching back to an agent starts a fresh request state");
assert.equal(avatar().props.style["--ui-agent-avatar-bg"], texture, "fallback texture remains stable across identity changes");
succeed(); // Cached image load events take the same path.
show({ agentId: "" });
assert.equal(state(), "fallback");
assert.equal(avatar().props["data-initial"], "?");
assert.equal(renderer.root.findAllByType("img").length, 0, "an unassigned avatar does not request /avatar/");
show({ fallback: "🦉" });
assert.equal(avatar().props["data-initial"], "🦉");
show({ name: "𠮷野" });
assert.equal(avatar().props["data-initial"], "𠮷", "fallback initials preserve Unicode code points");
act(() => renderer.unmount());
renderer = undefined;
cachedImage = { complete: true, naturalWidth: 768 };
show({ agentId: "cached" });
assert.equal(state(), "loaded", "a cached image removes its fallback before paint without waiting for a load event");
assert.equal(avatar().props.style.background, "transparent");
act(() => renderer.unmount());
console.log("PASS shared avatars: transparent image layer, loading/failure fallback, cached image mount, identity/version retry, stable textures and Unicode initials");
