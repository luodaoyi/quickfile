import "./three.min.js";

const frameDuration = 1000 / 60;

// Wormhole's galaxy renderer, with asset loading adapted to local modules.
class Galaxy {
  constructor(canvas) {
    this.canvas = canvas;
    this.isAnimationActive = true;
    this.forceRender = true;
    this.destroyed = false;
    this.framesSinceLastRender = 0;
    this.lastTime = null;
    this.isWarping = false;
    this.warpTimeout = null;
    this.hyperspace = null;
    this.shake = null;
    this.warpParams = {
      offsetX: 0,
      offsetY: 0,
      repeatX: 10,
      repeatY: 4,
      cameraShake: 0,
    };
    this.render = this.render.bind(this);
    this.handleMouseMove = (event) => {
      if (this.isWarping) {
        this.mouse.target.x = event.clientX;
        this.mouse.target.y = event.clientY;
      }
    };
    this.handleResize = () => {
      clearTimeout(this.resizeTimeout);
      this.resizeTimeout = setTimeout(() => {
        this.resize();
        this.forceRender = true;
      }, 250);
    };
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    this.handleReducedMotion = () =>
      this.setAnimation(!this.reducedMotion.matches);
    this.handleReducedMotion();
  }

  async init() {
    this.THREE = globalThis.THREE;
    const texture = await new this.THREE.TextureLoader().loadAsync(
      "/galaxy.jpg",
    );
    if (this.destroyed) return;
    this.width = innerWidth;
    this.height = innerHeight;
    this.updateRotationSpeed();
    const x = Math.random(),
      y = Math.random();
    this.mouse = {
      position: new this.THREE.Vector2(this.width * x, this.height * y),
      positionPercent: new this.THREE.Vector2(x, y),
      target: new this.THREE.Vector2(this.width * x, this.height * y),
    };
    this.renderer = new this.THREE.WebGLRenderer({
      antialias: true,
      canvas: this.canvas,
      failIfMajorPerformanceCaveat: true,
    });
    this.pixelRatioQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    this.renderer.setPixelRatio(Math.min(0.75 * devicePixelRatio, 1));
    this.renderer.setSize(this.width, this.height);
    this.camera = new this.THREE.PerspectiveCamera(
      15,
      this.width / this.height,
      0.01,
      1000,
    );
    this.camera.rotation.y = Math.PI;
    this.camera.position.z = 0.35;
    this.updateCameraPosition();
    this.scene = new this.THREE.Scene();
    this.pixelRatioQuery.addListener(this.handleResize);
    window.addEventListener("resize", this.handleResize);
    document.body.addEventListener("mousemove", this.handleMouseMove);
    this.reducedMotion.addEventListener("change", this.handleReducedMotion);
    this.createMesh(texture);
    this.render();
  }

  createMesh(texture) {
    this.splineGeometry = new this.THREE.BufferGeometry();
    const points = [];
    for (let i = 0; i < 5; i++)
      points.push(new this.THREE.Vector3(0, 0, (i / 4) * 3));
    points[4].y = -0.06;
    this.curve = new this.THREE.CatmullRomCurve3(points);
    this.tubeGeometry = new this.THREE.TubeGeometry(
      this.curve,
      70,
      0.02,
      30,
      false,
    );
    this.originalTubeGeometry = this.tubeGeometry.clone();
    this.updateCurve(Infinity);
    this.tubeMaterial = new this.THREE.MeshBasicMaterial({
      side: this.THREE.BackSide,
      map: texture,
    });
    texture.wrapS = texture.wrapT = this.THREE.MirroredRepeatWrapping;
    this.updateMaterialOffset();
    this.scene.add(new this.THREE.Mesh(this.tubeGeometry, this.tubeMaterial));
  }

  updateRotationSpeed() {
    this.rotationSpeed =
      this.width > 2500
        ? 0.00005
        : this.width > 2000
          ? 0.000075
          : this.width > 1500
            ? 0.0001
            : this.width > 1000
              ? 0.0002
              : this.width > 500
                ? 0.0003
                : 0.0004;
  }

  resize() {
    const oldWidth = this.width,
      oldHeight = this.height;
    this.width = innerWidth;
    this.height = innerHeight;
    this.updateRotationSpeed();
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.pixelRatioQuery.removeListener(this.handleResize);
    this.pixelRatioQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    this.pixelRatioQuery.addListener(this.handleResize);
    this.renderer.setPixelRatio(Math.min(0.75 * devicePixelRatio, 1));
    this.renderer.setSize(this.width, this.height);
    this.mouse.position.x *= this.width / oldWidth;
    this.mouse.position.y *= this.height / oldHeight;
    this.mouse.target.x *= this.width / oldWidth;
    this.mouse.target.y *= this.height / oldHeight;
  }

  setAnimation(active) {
    this.isAnimationActive = active;
  }

  async warp() {
    if (this.destroyed || !this.isAnimationActive || this.isWarping) return;
    this.isWarping = true;
    const { gsap, RoughEase } = await import("./warp.js");
    if (!this.isWarping) return;
    this.warpTimeout = setTimeout(() => this.stopWarp(), 14000);
    this.hyperspace = gsap.timeline();
    this.hyperspace.to(this.warpParams, 4, {
      repeatX: 0.3,
      ease: "power1.easeInOut",
    });
    this.hyperspace.to(
      this.warpParams,
      12,
      { offsetX: 8, ease: "power2.easeInOut" },
      0,
    );
    this.hyperspace.to(
      this.warpParams,
      6,
      { repeatX: 10, ease: "power2.easeInOut" },
      "-=5",
    );
    this.shake = gsap.timeline();
    this.shake.to(
      this.warpParams,
      2,
      {
        cameraShake: -0.005,
        ease: RoughEase.ease.config({
          template: "power0.easeNone",
          strength: 0.5,
          points: 100,
          taper: "none",
          randomize: true,
          clamp: false,
        }),
      },
      4,
    );
    this.shake.to(this.warpParams, 1, {
      cameraShake: 0,
      ease: RoughEase.ease.config({
        template: "power0.easeNone",
        strength: 0.5,
        points: 100,
        taper: "none",
        randomize: true,
        clamp: false,
      }),
    });
  }

  stopWarp() {
    if (this.destroyed || !this.isWarping) return;
    clearTimeout(this.warpTimeout);
    this.isWarping = false;
    if (this.hyperspace) {
      this.hyperspace.kill();
      this.warpParams.offsetX = 0;
      this.warpParams.repeatX = 10;
    }
    if (this.shake) {
      this.shake.kill();
      this.warpParams.cameraShake = 0;
    }
  }

  updateMousePosition(elapsed) {
    this.mouse.position.x +=
      (this.mouse.target.x - this.mouse.position.x) *
      Math.min(1, elapsed / frameDuration / 50);
    this.mouse.position.y +=
      (this.mouse.target.y - this.mouse.position.y) *
      Math.min(1, elapsed / frameDuration / 50);
    this.mouse.positionPercent.x = this.mouse.position.x / this.width;
    this.mouse.positionPercent.y = this.mouse.position.y / this.height;
  }

  updateRotation(elapsed) {
    this.warpParams.offsetY += this.rotationSpeed * (elapsed / frameDuration);
  }

  updateMaterialOffset() {
    const map = this.tubeMaterial.map;
    map.offset.x = this.warpParams.offsetX;
    map.offset.y = this.warpParams.offsetY;
    map.repeat.x = this.warpParams.repeatX;
    map.repeat.y = this.warpParams.repeatY;
  }

  updateCameraPosition() {
    this.camera.position.x =
      0.044 * this.mouse.positionPercent.x -
      0.025 +
      this.warpParams.cameraShake;
    this.camera.position.y = 0.044 * this.mouse.positionPercent.y - 0.025;
  }

  updateCurve(elapsed) {
    this.curve.points[2].x = this.curve.points[4].x =
      0.6 * (1 - this.mouse.positionPercent.x) - 0.3;
    this.curve.points[2].y = this.curve.points[4].y =
      0.6 * (1 - this.mouse.positionPercent.y) - 0.3;
    this.splineGeometry.setFromPoints(this.curve.getPoints(70));
    const position = new this.THREE.Vector3(),
      original = new this.THREE.Vector3(),
      center = new this.THREE.Vector3();
    const positions = this.tubeGeometry.getAttribute("position");
    const originals = this.originalTubeGeometry.getAttribute("position");
    const centers = this.splineGeometry.getAttribute("position");
    const ringSize = positions.count / centers.count;
    for (let i = 0; i < positions.count; i++) {
      position.fromBufferAttribute(positions, i);
      original.fromBufferAttribute(originals, i);
      center.fromBufferAttribute(centers, Math.floor(i / ringSize));
      positions.setX(
        i,
        position.x +
          (original.x + center.x - position.x) *
            Math.min(1, elapsed / frameDuration / 10),
      );
      positions.setY(
        i,
        position.y +
          (original.y + center.y - position.y) *
            Math.min(1, elapsed / frameDuration / 10),
      );
    }
    positions.needsUpdate = true;
  }

  render(now) {
    if (this.destroyed) return;
    let shouldRender = this.forceRender;
    if (this.isAnimationActive) {
      this.framesSinceLastRender++;
      if (this.framesSinceLastRender >= 3 || this.isWarping)
        shouldRender = true;
    }
    if (shouldRender) {
      if (now != null && this.lastTime != null) {
        const elapsed = now - this.lastTime;
        if (this.isWarping) this.updateMousePosition(elapsed);
        this.updateRotation(elapsed);
        this.updateMaterialOffset();
        if (this.isWarping) {
          this.updateCameraPosition();
          this.updateCurve(elapsed);
        }
        this.forceRender = false;
      }
      this.renderer.render(this.scene, this.camera);
      this.lastTime = now;
      this.framesSinceLastRender = 0;
    }
    requestAnimationFrame(this.render);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.warpTimeout);
    clearTimeout(this.resizeTimeout);
    this.pixelRatioQuery?.removeListener(this.handleResize);
    window.removeEventListener("resize", this.handleResize);
    document.body.removeEventListener("mousemove", this.handleMouseMove);
    this.reducedMotion.removeEventListener("change", this.handleReducedMotion);
  }
}

export async function startGalaxy(canvas) {
  const background = new Galaxy(canvas);
  await background.init();
  return background;
}
