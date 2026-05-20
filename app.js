const video = document.querySelector("#camera");
const canvas = document.querySelector("#output");
const ctx = canvas.getContext("2d", { alpha: false });
const startButton = document.querySelector("#startButton");
const fullscreenButton = document.querySelector("#fullscreenButton");
const permissionPanel = document.querySelector("#permissionPanel");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");

const MIN_STRETCH_SOURCE_RATIO = 0.02;
const MAX_STRETCH_SOURCE_RATIO = 0.08;

const BLUEPRINTS = [
  { anchor: "head", dx: -0.02, dy: 0.02, size: 0.3, aspect: 1 },
  { anchor: "head", dx: 0.12, dy: 0.08, size: 0.14, aspect: 0.65 },
  { anchor: "shoulders", dx: -0.12, dy: 0.02, size: 0.52, aspect: 2.6 },
  { anchor: "chest", dx: 0.1, dy: -0.02, size: 0.44, aspect: 0.58 },
  { anchor: "leftArm", dx: -0.04, dy: 0, size: 0.2, aspect: 0.55 },
  { anchor: "rightArm", dx: 0.04, dy: 0, size: 0.18, aspect: 1 },
  { anchor: "hips", dx: 0.06, dy: -0.02, size: 0.58, aspect: 2.9 },
  { anchor: "leftLeg", dx: -0.02, dy: 0.02, size: 0.2, aspect: 0.42 },
  { anchor: "rightLeg", dx: 0.02, dy: 0.02, size: 0.24, aspect: 0.46 },
  { anchor: "knees", dx: -0.08, dy: 0.02, size: 0.42, aspect: 2.2 },
  { anchor: "ankles", dx: 0.1, dy: -0.02, size: 0.16, aspect: 1 },
  { anchor: "torso", dx: -0.08, dy: 0.02, size: 0.1, aspect: 0.75 },
  { anchor: "leftForearm", dx: 0.02, dy: 0, size: 0.12, aspect: 1.2 },
  { anchor: "rightForearm", dx: -0.02, dy: 0, size: 0.11, aspect: 0.7 },
  { anchor: "lowerBody", dx: 0, dy: 0.02, size: 0.28, aspect: 1.4 },
];

let model = null;
let poseDetector = null;
let detections = [];
let lastDetectionAt = 0;
let detectionBusy = false;
let running = false;
let view = { x: 0, y: 0, width: 1, height: 1, scale: 1 };
let animationFrame = 0;

function setStatus(message, state = "loading") {
  statusText.textContent = message;
  statusDot.classList.toggle("ready", state === "ready");
  statusDot.classList.toggle("error", state === "error");
}

function resizeCanvas() {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.floor(window.innerWidth * pixelRatio);
  const height = Math.floor(window.innerHeight * pixelRatio);

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  }
}

function updateCoverView() {
  const videoWidth = video.videoWidth || 1280;
  const videoHeight = video.videoHeight || 720;
  const scale = Math.max(canvas.width / videoWidth, canvas.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;

  view = {
    x: (canvas.width - width) * 0.5,
    y: (canvas.height - height) * 0.5,
    width,
    height,
    scale,
  };
}

function toCanvasBox(box) {
  return {
    x: view.x + box[0] * view.scale,
    y: view.y + box[1] * view.scale,
    width: box[2] * view.scale,
    height: box[3] * view.scale,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function seededRandom(seed) {
  return Math.sin(seed * 9283.37) * 0.5 + 0.5;
}

function pickCountForDistance(personBox) {
  const heightRatio = personBox.height / canvas.height;
  if (heightRatio > 0.68) return 7;
  if (heightRatio > 0.5) return 9;
  if (heightRatio > 0.34) return 12;
  return 15;
}

function pointBetween(a, b, amount = 0.5) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
  };
}

function averagePoints(points) {
  const valid = points.filter(Boolean);
  if (!valid.length) return null;
  return {
    x: valid.reduce((sum, point) => sum + point.x, 0) / valid.length,
    y: valid.reduce((sum, point) => sum + point.y, 0) / valid.length,
  };
}

function drawVideoCover() {
  updateCoverView();
  ctx.drawImage(video, view.x, view.y, view.width, view.height);
}

function drawIdle() {
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#171717");
  gradient.addColorStop(1, "#050505");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function canvasToVideoX(x) {
  return (x - view.x) / view.scale;
}

function canvasToVideoY(y) {
  return (y - view.y) / view.scale;
}

function keypointToCanvas(keypoint) {
  if (!keypoint || keypoint.score < 0.22) return null;
  return {
    x: view.x + keypoint.x * view.scale,
    y: view.y + keypoint.y * view.scale,
  };
}

function poseToAnchors(pose, fallbackBox) {
  if (!pose?.keypoints?.length) return null;

  const visiblePoints = pose.keypoints.map(keypointToCanvas).filter(Boolean);
  const points = new Map(
    pose.keypoints.map((keypoint) => [keypoint.name || keypoint.part, keypointToCanvas(keypoint)]),
  );
  const head = averagePoints([
    points.get("nose"),
    points.get("left_eye"),
    points.get("right_eye"),
    points.get("left_ear"),
    points.get("right_ear"),
  ]);
  const leftShoulder = points.get("left_shoulder");
  const rightShoulder = points.get("right_shoulder");
  const leftElbow = points.get("left_elbow");
  const rightElbow = points.get("right_elbow");
  const leftWrist = points.get("left_wrist");
  const rightWrist = points.get("right_wrist");
  const leftHip = points.get("left_hip");
  const rightHip = points.get("right_hip");
  const leftKnee = points.get("left_knee");
  const rightKnee = points.get("right_knee");
  const leftAnkle = points.get("left_ankle");
  const rightAnkle = points.get("right_ankle");
  const shoulders = averagePoints([leftShoulder, rightShoulder]);
  const hips = averagePoints([leftHip, rightHip]);

  if ((!head && !shoulders && !hips) || visiblePoints.length < 5) return null;

  const minX = Math.min(...visiblePoints.map((point) => point.x));
  const maxX = Math.max(...visiblePoints.map((point) => point.x));
  const minY = Math.min(...visiblePoints.map((point) => point.y));
  const maxY = Math.max(...visiblePoints.map((point) => point.y));
  const poseWidth = Math.max(24, maxX - minX);
  const poseHeight = Math.max(24, maxY - minY);
  const bounds = {
    x: clamp(minX - poseWidth * 0.12, fallbackBox.x + fallbackBox.width * 0.08, fallbackBox.x + fallbackBox.width * 0.42),
    y: clamp(minY - poseHeight * 0.08, fallbackBox.y, fallbackBox.y + fallbackBox.height * 0.26),
    width: Math.min(poseWidth * 1.24, fallbackBox.width * 0.84),
    height: Math.min(poseHeight * 1.16, fallbackBox.height * 0.96),
  };

  return {
    head: head || pointBetween(shoulders, null),
    shoulders,
    chest: pointBetween(shoulders, hips, 0.35),
    torso: pointBetween(shoulders, hips, 0.55),
    hips,
    leftArm: pointBetween(leftShoulder, leftElbow, 0.55) || leftShoulder,
    rightArm: pointBetween(rightShoulder, rightElbow, 0.55) || rightShoulder,
    leftForearm: pointBetween(leftElbow, leftWrist, 0.48) || leftElbow,
    rightForearm: pointBetween(rightElbow, rightWrist, 0.48) || rightElbow,
    leftLeg: pointBetween(leftHip, leftKnee, 0.62) || leftHip,
    rightLeg: pointBetween(rightHip, rightKnee, 0.62) || rightHip,
    knees: averagePoints([leftKnee, rightKnee]),
    ankles: averagePoints([leftAnkle, rightAnkle]),
    lowerBody: pointBetween(hips, averagePoints([leftKnee, rightKnee]), 0.65),
    fallback: {
      x: fallbackBox.x + fallbackBox.width * 0.5,
      y: fallbackBox.y + fallbackBox.height * 0.5,
    },
    bounds,
  };
}

function boxToFallbackAnchors(box) {
  const insetX = box.width * 0.22;
  const body = {
    x: box.x + insetX,
    y: box.y + box.height * 0.03,
    width: box.width - insetX * 2,
    height: box.height * 0.94,
  };
  const point = (x, y) => ({
    x: body.x + body.width * x,
    y: body.y + body.height * y,
  });

  return {
    head: point(0.5, 0.07),
    shoulders: point(0.5, 0.2),
    chest: point(0.5, 0.32),
    torso: point(0.5, 0.45),
    hips: point(0.5, 0.56),
    leftArm: point(0.2, 0.35),
    rightArm: point(0.8, 0.35),
    leftForearm: point(0.18, 0.48),
    rightForearm: point(0.82, 0.48),
    leftLeg: point(0.36, 0.72),
    rightLeg: point(0.64, 0.72),
    knees: point(0.5, 0.8),
    ankles: point(0.5, 0.95),
    lowerBody: point(0.5, 0.72),
    fallback: point(0.5, 0.5),
    bounds: body,
  };
}

function clampRectToBounds(rect, bounds) {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    x: clamp(rect.x, bounds.x, bounds.x + bounds.width - width),
    y: clamp(rect.y, bounds.y, bounds.y + bounds.height - height),
    width,
    height,
  };
}

function matchPoseToBox(box, poses) {
  if (!poses?.length) return null;
  const boxCenter = {
    x: box.x + box.width * 0.5,
    y: box.y + box.height * 0.5,
  };

  return poses
    .map((pose) => {
      const keypoints = pose.keypoints
        .map(keypointToCanvas)
        .filter(Boolean)
        .filter((point) => (
          point.x >= box.x - box.width * 0.25 &&
          point.x <= box.x + box.width * 1.25 &&
          point.y >= box.y - box.height * 0.12 &&
          point.y <= box.y + box.height * 1.12
        ));
      const center = averagePoints(keypoints);
      if (!center) return null;
      return {
        pose,
        distance: Math.hypot(center.x - boxCenter.x, center.y - boxCenter.y),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)[0]?.pose || null;
}

function drawSlice(rect, personBox, index, stretchSourceRatio) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const localCenterX = clamp(
    rect.x + rect.width * 0.5,
    personBox.x + personBox.width * 0.08,
    personBox.x + personBox.width * 0.92,
  );
  const localCenterY = clamp(
    rect.y + rect.height * 0.5,
    personBox.y + personBox.height * 0.04,
    personBox.y + personBox.height * 0.96,
  );
  const sourceCenterX = canvasToVideoX(localCenterX);
  const sourceCenterY = canvasToVideoY(localCenterY);
  const destinationWidth = rect.width / view.scale;
  const destinationHeight = rect.height / view.scale;
  const sourceWidth = Math.max(1, destinationWidth * stretchSourceRatio);
  const sourceHeight = Math.max(2, Math.min(videoHeight, destinationHeight));
  const sx = clamp(sourceCenterX - sourceWidth * 0.5, 0, videoWidth - sourceWidth);
  const sy = clamp(sourceCenterY - sourceHeight * 0.5, 0, videoHeight - sourceHeight);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.filter = "saturate(1.12) contrast(1.04)";
  ctx.drawImage(video, sx, sy, sourceWidth, sourceHeight, rect.x, rect.y, rect.width, rect.height);

  ctx.globalAlpha = 0.05;
  ctx.fillStyle = index % 2 ? "#fffdf2" : "#111";
  const lineSize = Math.max(1, Math.round(canvas.width / 1800));
  const step = Math.max(8, Math.round(rect.width / 12));
  for (let x = rect.x; x < rect.x + rect.width; x += step) {
    ctx.fillRect(x, rect.y, lineSize, rect.height);
  }

  ctx.restore();
}

function drawGridRect(rect, personBox, index, stretchSourceRatio) {
  if (rect.width < 6 || rect.height < 6) return;

  ctx.save();
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();

  drawSlice(rect, personBox, index, stretchSourceRatio);
}

function drawPersonEffect(detection, personIndex) {
  const box = toCanvasBox(detection.bbox);
  const minSide = Math.min(box.width, box.height);
  if (minSide < 28) return;

  const drift = Math.sin(performance.now() * 0.0012 + personIndex * 2.3) * box.width * 0.015;
  const blockBase = Math.min(box.width, box.height) * 0.74;
  const pose = matchPoseToBox(box, detection.poses);
  const anchors = poseToAnchors(pose, box) || boxToFallbackAnchors(box);
  const blockCount = pickCountForDistance(box);

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.08)";
  ctx.shadowBlur = Math.max(3, canvas.width * 0.003);

  BLUEPRINTS.slice(0, blockCount).forEach((item, index) => {
    const random = seededRandom((personIndex + 1) * 31 + index * 17);
    const jitterX = (seededRandom((personIndex + 1) * 53 + index * 23) - 0.5) * blockBase * 0.24;
    const jitterY = (seededRandom((personIndex + 1) * 71 + index * 29) - 0.5) * blockBase * 0.2;
    const sizeJitter = 0.82 + seededRandom((personIndex + 1) * 89 + index * 31) * 0.36;
    const stretchSourceRatio =
      MIN_STRETCH_SOURCE_RATIO +
      random * (MAX_STRETCH_SOURCE_RATIO - MIN_STRETCH_SOURCE_RATIO);
    const anchor = anchors[item.anchor] || anchors.fallback;
    const width = item.size * sizeJitter * blockBase * Math.sqrt(item.aspect);
    const height = (item.size * sizeJitter * blockBase) / Math.sqrt(item.aspect);
    const rect = {
      x: anchor.x + item.dx * blockBase - width * 0.5 + drift + jitterX,
      y: anchor.y + item.dy * blockBase - height * 0.5 + jitterY,
      width,
      height,
    };
    drawGridRect(
      clampRectToBounds(rect, anchors.bounds),
      box,
      personIndex * BLUEPRINTS.length + index,
      stretchSourceRatio,
    );
  });
  ctx.restore();
}

async function detectPeople() {
  if (detectionBusy || !model || video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return;

  try {
    detectionBusy = true;
    const [predictions, poses] = await Promise.all([
      model.detect(video, 8),
      poseDetector ? poseDetector.estimatePoses(video, { maxPoses: 6, flipHorizontal: false }) : [],
    ]);
    detections = predictions
      .filter((item) => item.class === "person" && item.score > 0.46)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((item) => ({ ...item, poses }));

    const label = detections.length ? `识别到 ${detections.length} 人` : "等待人物进入画面";
    setStatus(label, "ready");
  } catch (error) {
    setStatus("识别模型运行失败", "error");
    console.error(error);
  } finally {
    detectionBusy = false;
  }
}

function render() {
  resizeCanvas();

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    drawVideoCover();
    detections.forEach(drawPersonEffect);
  } else {
    drawIdle();
  }

  const now = performance.now();
  if (running && now - lastDetectionAt > 130) {
    lastDetectionAt = now;
    detectPeople();
  }

  animationFrame = requestAnimationFrame(render);
}

async function startCamera() {
  if (running) return;

  try {
    setStatus("请求摄像头权限");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();
    permissionPanel.classList.add("is-hidden");

    setStatus("加载人物识别模型");
    if (!window.cocoSsd) {
      throw new Error("COCO-SSD model script was not loaded");
    }
    if (!model) {
      model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    }
    if (!poseDetector && window.poseDetection) {
      try {
        if (window.tf?.setBackend) {
          await tf.setBackend("webgl");
          await tf.ready();
        }
        poseDetector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          {
            modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
            enableTracking: true,
            trackerType: poseDetection.TrackerType?.BoundingBox,
          },
        );
      } catch (poseError) {
        try {
          poseDetector = await poseDetection.createDetector(
            poseDetection.SupportedModels.MoveNet,
            { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING },
          );
        } catch (singlePoseError) {
          console.warn("Pose detector is unavailable; using narrowed body boxes.", poseError, singlePoseError);
        }
      }
    }

    running = true;
    setStatus("等待人物进入画面", "ready");
  } catch (error) {
    const message = error.name === "NotAllowedError"
      ? "摄像头权限被拒绝"
      : error.message.includes("COCO-SSD")
        ? "识别库加载失败"
        : "无法打开摄像头";
    setStatus(message, "error");
    console.error(error);
  }
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (error) {
    setStatus("当前浏览器无法切换全屏", "error");
  }
}

window.addEventListener("resize", resizeCanvas);
startButton.addEventListener("click", startCamera);
fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  fullscreenButton.querySelector("span").textContent = document.fullscreenElement ? "退出" : "全屏";
});

resizeCanvas();
render();
