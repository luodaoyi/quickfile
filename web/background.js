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
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  resize();
  window.addEventListener("resize", resize);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let previous = 0;
  function animate(now) {
    requestAnimationFrame(animate);
    if (document.hidden || reducedMotion.matches || now - previous < 50) return;
    const elapsed = previous ? now - previous : 0;
    previous = now;
    const speed = innerWidth > 1500 ? 0.006 : innerWidth > 1000 ? 0.012 : 0.018;
    texture.offset.y += (elapsed / 1000) * speed;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}
