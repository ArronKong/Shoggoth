MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Mozilla Public License 2.0 components

The packaged Cua Node runtime also contains the following MPL-2.0 components:

- `@ubjs/core` 0.31.0-3
- `@ubjs/node` 0.31.0-3
- `@ubjs/node-darwin-arm64` 0.31.0-3
- `@ubjs/node-darwin-x64` 0.31.0-3
- the `cua_driver_node_runtime.node` compatibility runtime in
  `@trycua/cua-driver-darwin-arm64` and `@trycua/cua-driver-darwin-x64` 0.22.0

These components are licensed under the Mozilla Public License, version 2.0.
The complete license is included in [MPL-2.0.txt](MPL-2.0.txt) and is available at
<https://www.mozilla.org/MPL/2.0/>.

The corresponding source for the UniFFI runtime and Cua compatibility build is available from:

- `@ubjs/core` 0.31.0-3:
  <https://github.com/jhugman/uniffi-bindgen-react-native/tree/49bc59194d183a05855ed4104c18eb92fb465e02/typescript>
- `@ubjs/node` and the macOS native packages 0.31.0-3:
  <https://github.com/jhugman/uniffi-bindgen-react-native/tree/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449/runtimes/napi>
- <https://github.com/trycua/cua/tree/cua-driver-rs-v0.22.0>

Shoggoth does not modify these files. Their pinned package archives and hashes are recorded in
`cua-driver/manifest.json` and the packaged CycloneDX SBOM.
