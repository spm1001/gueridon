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

export default defineConfig({
  plugins: [litClassFieldFix(), tailwindcss()],
  optimizeDeps: {
    esbuildOptions: {
      target: "es2020",
    },
  },
});
