import "./three.min.js";

// A textured tube supplies the same moving galaxy perspective as the reference.
export async function startGalaxy(canvas) {
  const THREE = globalThis.THREE;
  const texture = await new THREE.TextureLoader().loadAsync("/galaxy.jpg");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    failIfMajorPerformanceCaveat: true,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    15,
    innerWidth / innerHeight,
    0.01,
    1000,
  );
  camera.rotation.y = Math.PI;
  camera.position.set(-0.004, -0.005, 0.35);

  const points = Array.from(
    { length: 5 },
    (_, index) => new THREE.Vector3(0, 0, index * 0.75),
  );
  points[4].y = -0.06;
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, 70, 0.02, 30, false);
  const positions = geometry.getAttribute("position");
  points[2].x = points[4].x = 0.025;
  points[2].y = points[4].y = 0.04;
  const centers = curve.getPoints(70);
  for (let index = 0; index < positions.count; index++) {
    const center = centers[Math.floor(index / 31)];
    positions.setXY(
      index,
      positions.getX(index) + center.x,
      positions.getY(index) + center.y,
    );
  }
  positions.needsUpdate = true;
  texture.wrapS = texture.wrapT = THREE.MirroredRepeatWrapping;
  texture.repeat.set(10, 4);
  const material = new THREE.MeshBasicMaterial({
    side: THREE.BackSide,
    map: texture,
  });
  scene.add(new THREE.Mesh(geometry, material));

  function resize() {
    renderer.setPixelRatio(Math.min(devicePixelRatio * 0.75, 1));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  resize();
  window.addEventListener("resize", resize);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let previous = null;
  let framesSinceRender = 0;
  let warpStarted = null;
  let warping = false;
  let warpOffset = 0;
  const pointer = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5 };
  document.addEventListener("pointermove", (event) => {
    pointer.targetX = event.clientX / innerWidth;
    pointer.targetY = event.clientY / innerHeight;
  });
  const ease = (value) => {
    const p = Math.max(0, Math.min(1, value));
    return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
  };
  function animate(now) {
    requestAnimationFrame(animate);
    if (document.hidden || reducedMotion.matches) {
      previous = null;
      framesSinceRender = 0;
      return;
    }
    // Match the reference: every third refresh at rest, every refresh during warp.
    if (++framesSinceRender < 3 && !warping) return;
    framesSinceRender = 0;
    const elapsed = previous === null ? 0 : now - previous;
    previous = now;
    const speed = innerWidth > 1500 ? 0.006 : innerWidth > 1000 ? 0.012 : 0.018;
    texture.offset.y += (elapsed / 1000) * speed;
    pointer.x += (pointer.targetX - pointer.x) * Math.min(1, elapsed / 800);
    pointer.y += (pointer.targetY - pointer.y) * Math.min(1, elapsed / 800);
    let repeat = 10,
      shake = 0;
    if (warpStarted !== null) {
      const seconds = (now - warpStarted) / 1000;
      repeat = 10 - 9.7 * ease(seconds / 4) + 9.7 * ease((seconds - 9) / 6);
      texture.offset.x = warpOffset + 8 * ease(seconds / 12);
      if (seconds >= 4 && seconds < 7)
        shake =
          Math.sin(now * 0.053) *
          0.0025 *
          Math.min(1, seconds - 4, 7 - seconds);
      if (seconds >= 15) {
        warpStarted = null;
        warping = false;
      }
    } else {
      repeat =
        texture.repeat.x + (10 - texture.repeat.x) * Math.min(1, elapsed / 500);
    }
    texture.repeat.x = repeat;
    camera.position.x = 0.044 * pointer.x - 0.025 + shake;
    camera.position.y = 0.044 * pointer.y - 0.025;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
  return {
    setWarp(active) {
      if (active && !warping && !reducedMotion.matches) {
        warpStarted = performance.now();
        warpOffset = texture.offset.x;
      }
      if (!active) warpStarted = null;
      warping = active;
    },
  };
}
