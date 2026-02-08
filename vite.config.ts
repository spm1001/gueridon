import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

// pi-web-ui is compiled by tsgo which ignores useDefineForClassFields:false,
// emitting native class fields. esbuild's pre-bundling downlevels these to
// __publicField() calls that use Object.defineProperty ([[Define]] semantics),
// which shadows Lit's reactive property accessors defined by @state/@property.
//
// Fix: rewrite __defNormalProp to try simple assignment first ([[Set]]),
// which triggers Lit @state/@property setters. If assignment throws
// (getter-only properties from @query), silently skip — the getter stays.
function litClassFieldFix(): Plugin {
  return {
    name: "lit-class-field-fix",
    transform(code, id) {
      if (!id.includes("node_modules/.vite/deps/")) return;
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
