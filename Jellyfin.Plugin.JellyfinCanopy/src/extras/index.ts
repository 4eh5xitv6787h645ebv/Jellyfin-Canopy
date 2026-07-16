// src/extras/index.ts
// their required execution order (the former allComponentScripts order).
// Owned by the extras conversion wave; main.ts imports this barrel once, so
// conversions never edit main.ts itself. login-image.js stays out-of-band
// (loaded pre-login, config-gated) and is deliberately NOT imported here.
// Every extras owner is a manifest-backed lazy entry. Keep this compatibility
// barrel import-pure so it cannot pull disabled features into cold boot.
