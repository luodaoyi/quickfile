function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(script);
  });
}

await loadScript("/gsap.min.js");
await loadScript("/EasePack.min.js");
export const { gsap, RoughEase } = globalThis;
