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

export default defineConfig({
  plugins: [litClassFieldFix(), tailwindcss()],
  server: {
    allowedHosts: ["kube"],
  },
  resolve: {
    alias: {
      // Deduplicate Lit: vendored files import lit, which must resolve to
      // guéridon's copy. Two Lit runtimes = broken instanceof checks.
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
    esbuildOptions: {
      target: "es2020",
    },
  },
});
