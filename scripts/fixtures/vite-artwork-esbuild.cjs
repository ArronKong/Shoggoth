"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

// These offline UI fixtures still use esbuild for their instrumentation. Expand
// the two production Vite artwork globs from real local bytes, rather than
// leaving import.meta.glob in the browser or substituting an empty icon map.
function viteArtworkFixturePlugin(root) {
  const ui = path.join(root, "app/manage-ui");
  const ts = createRequire(path.join(ui, "package.json"))("typescript");
  const assetRoot = path.join(ui, "src/assets") + path.sep;
  return { name: "vite-local-artwork-fixture", setup(builder) {
    builder.onLoad({ filter: /[/\\](?:bundledMcpIcons\.ts|ProviderLogo\.tsx)$/ }, ({ path: file }) => {
      const source = fs.readFileSync(file, "utf8");
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const edits = [], files = [];
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "glob" && node.expression.expression.getText(tree) === "import.meta") {
          assert.equal(node.arguments.length, 2);
          const [pattern, options] = node.arguments;
          assert(ts.isStringLiteral(pattern) && ts.isObjectLiteralExpression(options));
          const values = Object.fromEntries(options.properties.map(item => {
            assert(ts.isPropertyAssignment(item));
            const key = item.name.text, value = item.initializer;
            assert(["eager", "query", "import"].includes(key), "unsupported fixture glob option");
            return [key, value.kind === ts.SyntaxKind.TrueKeyword ? true
              : ts.isStringLiteral(value) ? value.text : null];
          }));
          assert.equal(values.eager, true); assert.equal(values.import, "default");
          assert(["?raw", "?inline", "?url&no-inline"].includes(values.query), "unsupported fixture artwork query");
          const match = /^(.*\/)\*\.(png|svg)$/.exec(pattern.text);
          assert(match, "unsupported fixture artwork glob");
          const directory = path.resolve(path.dirname(file), match[1]);
          assert((directory + path.sep).startsWith(assetRoot), "artwork must stay under local assets");
          const names = fs.readdirSync(directory).filter(name => name.endsWith("." + match[2])).sort();
          assert(names.length > 0, "real fixture artwork must exist");
          const entries = names.map(name => {
            const asset = path.join(directory, name), bytes = fs.readFileSync(asset);
            assert(fs.lstatSync(asset).isFile() && !fs.lstatSync(asset).isSymbolicLink());
            files.push(asset);
            const value = values.query === "?raw" ? bytes.toString("utf8")
              : "data:" + (match[2] === "png" ? "image/png" : "image/svg+xml") + ";base64," + bytes.toString("base64");
            return [match[1] + name, value];
          });
          edits.push({ start: node.getStart(tree), end: node.end, text: JSON.stringify(Object.fromEntries(entries)) });
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      assert.equal(edits.length, 1, "expected exactly one real local artwork glob per module");
      let contents = source;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
      }
      return { contents, loader: path.extname(file).slice(1), resolveDir: path.dirname(file), watchFiles: files };
    });
  } };
}
module.exports = { viteArtworkFixturePlugin };
