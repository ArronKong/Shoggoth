# Cua Driver and Node runtime notice

Shoggoth redistributes Cua Driver/SDK 0.22.0 from Cua AI, Inc. under the MIT license.

`cua_driver_node_runtime.node` is a compatibility build derived from the N-API runtime in
`uniffi-bindgen-react-native` 0.31.0-3, copyright its contributors and licensed under the Mozilla
Public License 2.0. The corresponding source and deterministic build script are available in the
Cua repository at tag `cua-driver-rs-v0.22.0`.

Shoggoth pins and verifies the universal Cua Driver executable plus the architecture-specific npm
archives before packaging. Runtime self-update is not enabled; a Cua update requires a new signed
Shoggoth release candidate and packaged smoke verification.
