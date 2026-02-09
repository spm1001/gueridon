import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

// esbuild emits __publicField() / __defNormalProp() for class fields.
// When a field has a Lit decorator (@state, @property), the decorator creates
// a getter/setter on the prototype. __defNormalProp uses Object.defineProperty
// ([[Define]] semantics) which shadows the accessor with a data property,
// breaking Lit reactivity.
//
// Fix: rewrite __defNormalProp to try simple assignment first ([[Set]]),
// which triggers Lit @state/@property setters. If assignment throws
// (getter-only properties from @query), silently skip — the getter stays.
// Applies to all files (our source + pre-bundled deps) — any file with
// Lit decorators and esbuild class field output needs this.
function litClassFieldFix(): Plugin {
  return {
    name: "lit-class-field-fix",
    transform(code, id) {
      if (!code.includes("__defNormalProp")) return;

      const pattern =
        /var __defNormalProp[^=]*= \(obj, key, value\) => key in obj \? __defProp[^(]*\(obj, key, \{[^}]+\}\) : obj\[key\] = value;/g;
      const patched = code.replace(
        pattern,
        "var __defNormalProp = (obj, key, value) => { try { obj[key] = value; } catch(e) {} return value; };",
      );

      if (patched === code) {
        console.warn(
          `[lit-class-field-fix] __defNormalProp found but regex didn't match in ${id.split("/").pop()}. ` +
            "esbuild output format may have changed — Lit components will render blank.",
        );
      }

      return patched;
    },
  };
}

// Consume pi-web-ui from local fork source (~/Repos/pi-mono) instead of npm.
// Benefits: no build step, no stale dist/, HMR on component edits, and esbuild
// compiles with [[Set]] semantics (es2020 target) so Lit reactivity just works.
const PI_WEB_UI_SRC = "/Users/modha/Repos/pi-mono/packages/web-ui/src";

export default defineConfig({
  plugins: [litClassFieldFix(), tailwindcss()],
  resolve: {
    alias: {
      "@mariozechner/pi-web-ui": PI_WEB_UI_SRC,
      // Deduplicate Lit: web-ui source resolves lit from pi-mono's node_modules,
      // guéridon has its own copy. Two Lit runtimes = broken instanceof checks.
      // Force everything through guéridon's copy.
      "lit": resolve("node_modules/lit"),
      "lit/": resolve("node_modules/lit") + "/",
      "@lit/reactive-element": resolve("node_modules/@lit/reactive-element"),
    },
  },
  esbuild: {
    // [[Set]] semantics for class fields — Lit @state/@property setters need this.
    // esbuild ignores tsconfig; target controls class field emit strategy.
    target: "es2020",
  },
  optimizeDeps: {
    // Don't pre-bundle the aliased source — Vite transforms it directly.
    exclude: ["@mariozechner/pi-web-ui"],
    esbuildOptions: {
      target: "es2020",
    },
  },
  build: {
    rollupOptions: {
      // pi-ai bundles @aws-sdk/client-bedrock-runtime which pulls in Node.js-only
      // @smithy packages (stream, http, net). We don't use Bedrock — CC handles
      // the LLM call server-side. Externalizing prevents Rollup from failing on
      // Node.js imports that can't resolve in a browser bundle.
      external: [/^@smithy\//, /^@aws-sdk\//],
    },
  },
});
