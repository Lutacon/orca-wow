# tweetnacl (vendored)

`nacl-fast.js` and `LICENSE` are copied unmodified from the npm package
**tweetnacl 1.0.3** (public domain, see `LICENSE`):

- tarball: https://registry.npmjs.org/tweetnacl/-/tweetnacl-1.0.3.tgz
- integrity (registry `dist.integrity`, checked against the downloaded tarball):
  `sha512-6rt+RN7aOi1nGMyC4Xa5DdYiukl2UWCbcJft7YhxReBGQD7OAM8Pbxw6YMo4r2diNEA8FEmu32YOn9rhaiE5yw==`
- `nacl-fast.js` sha256: `6bcd37a3b20dce913f82d4b23e4e2b661058b4b953df8a3f8c45d56ac4f72447`

No scripts from the package were run. `package.json` here only marks the folder as
CommonJS so `createRequire` loads `nacl-fast.js` as the UMD/CommonJS file it is
(the bridge itself is ESM). Used by `src/orca-remote.js` for NaCl `box`/`secretbox`
(XSalsa20-Poly1305), which Node's crypto lacks; the same library Orca uses.
