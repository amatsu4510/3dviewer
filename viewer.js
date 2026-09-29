// CesiumJS 3D Model Viewer
// - 左ドラッグ: モデルを中心にカメラをオービット回転 (クオータニオン合成)
// - 右ドラッグ: 前後にズーム
// - ドロップダウン: モデル切替

const MODEL_SIZE = 180.0;

const MODELS = [
  {
    name: 'Milk Truck',
    uri: 'https://raw.githubusercontent.com/CesiumGS/cesium/main/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb',
  },
  {
    name: 'Cesium Man',
    uri: 'https://raw.githubusercontent.com/CesiumGS/cesium/main/Apps/SampleData/models/CesiumMan/Cesium_Man.glb',
  },
  {
    name: 'Ground Vehicle',
    uri: 'https://raw.githubusercontent.com/CesiumGS/cesium/main/Apps/SampleData/models/GroundVehicle/GroundVehicle.glb',
  },
];

// 軸・カメラ距離はすべて MODEL_SIZE に比例させる
const AXIS_LENGTH   = MODEL_SIZE * 4.0;
const AXIS_WIDTH    = 1;
const HEAD_LENGTH   = MODEL_SIZE * 0.2;
const HEAD_SPREAD   = MODEL_SIZE * 0.1;
const INIT_DISTANCE = MODEL_SIZE * 11.0;
const INIT_PITCH    = Cesium.Math.toRadians(-28); // 負方向でカメラが上に回る
const MIN_DISTANCE  = MODEL_SIZE * 0.3;
const MAX_DISTANCE  = MODEL_SIZE * 60.0;

const viewer = new Cesium.Viewer('cesiumContainer', {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  baseLayer: false,
  skyBox: false,
  skyAtmosphere: false,
  creditContainer: document.createElement('div'),
});

viewer.scene.globe.show = false;
viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a1a3f');

// モデル配置位置とローカルフレーム (ENU)
const modelPosition = Cesium.Cartesian3.fromDegrees(0, 0, 0);
const localFrame = Cesium.Transforms.eastNorthUpToFixedFrame(modelPosition);

const localEast = new Cesium.Cartesian3(
  localFrame[0], localFrame[1], localFrame[2],
);
const localNorth = new Cesium.Cartesian3(
  localFrame[4], localFrame[5], localFrame[6],
);
const localUp = new Cesium.Cartesian3(
  localFrame[8], localFrame[9], localFrame[10],
);

// モデル切替: 既存モデルエンティティを差し替える
let modelEntity = null;

function loadModel(uri) {
  if (modelEntity) {
    viewer.entities.remove(modelEntity);
  }
  modelEntity = viewer.entities.add({
    position: modelPosition,
    model: {
      uri,
      scale: MODEL_SIZE,
    },
  });
}

loadModel(MODELS[0].uri);

// XYZ軸 (ローカルENU: X=東, Y=北, Z=上) を描画
function offsetFromModel(axisVector, scale) {
  const off = Cesium.Cartesian3.multiplyByScalar(
    axisVector, scale, new Cesium.Cartesian3(),
  );
  return Cesium.Cartesian3.add(modelPosition, off, new Cesium.Cartesian3());
}

function arrowLegPoint(tip, dir, perp, sign) {
  const back = new Cesium.Cartesian3();
  Cesium.Cartesian3.multiplyByScalar(dir, -HEAD_LENGTH, back);
  Cesium.Cartesian3.add(tip, back, back);
  const side = new Cesium.Cartesian3();
  Cesium.Cartesian3.multiplyByScalar(perp, HEAD_SPREAD * sign, side);
  return Cesium.Cartesian3.add(back, side, new Cesium.Cartesian3());
}

const axes = [
  { name: 'X', dir: localEast,  perp: localUp,   color: Cesium.Color.RED },
  { name: 'Y', dir: localNorth, perp: localUp,   color: Cesium.Color.LIME },
  { name: 'Z', dir: localUp,    perp: localEast, color: Cesium.Color.CYAN },
];

for (const axis of axes) {
  const posEnd = offsetFromModel(axis.dir,  AXIS_LENGTH);
  const negEnd = offsetFromModel(axis.dir, -AXIS_LENGTH);

  // 軸本体: 反対方向にも同じ長さで伸ばす (矢印なし)
  viewer.entities.add({
    polyline: {
      positions: [negEnd, posEnd],
      width: AXIS_WIDTH,
      material: axis.color,
      arcType: Cesium.ArcType.NONE,
    },
  });

  // 矢印 "<" 形状: 単一平面の脚だけ描画
  {
    const legA = arrowLegPoint(posEnd, axis.dir, axis.perp, +1);
    const legB = arrowLegPoint(posEnd, axis.dir, axis.perp, -1);
    viewer.entities.add({
      polyline: {
        positions: [legA, posEnd, legB],
        width: AXIS_WIDTH,
        material: axis.color,
        arcType: Cesium.ArcType.NONE,
      },
    });
  }

  viewer.entities.add({
    position: posEnd,
    label: {
      text: axis.name,
      font: 'bold 20px sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: false,
      pixelOffset: new Cesium.Cartesian2(0, -14),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

// 既存のカメラ操作を無効化して独自制御に置き換える
const controller = viewer.scene.screenSpaceCameraController;
controller.enableRotate = false;
controller.enableTranslate = false;
controller.enableZoom = false;
controller.enableTilt = false;
controller.enableLook = false;

// オービット状態: 累積回転を単一クオータニオンで保持
const orbitQuat = Cesium.Quaternion.clone(Cesium.Quaternion.IDENTITY);
let distance = INIT_DISTANCE;

const ROTATE_SPEED = 0.006;
const ZOOM_SPEED = 0.01;

const scratchMatrix = new Cesium.Matrix3();
const scratchOffset = new Cesium.Cartesian3();
const scratchRotatedOffset = new Cesium.Cartesian3();
const scratchCameraPos = new Cesium.Cartesian3();
const scratchDirection = new Cesium.Cartesian3();
const scratchUp = new Cesium.Cartesian3();
const scratchRight = new Cesium.Cartesian3();
const scratchYawQuat = new Cesium.Quaternion();
const scratchPitchQuat = new Cesium.Quaternion();

function updateCamera() {
  Cesium.Matrix3.fromQuaternion(orbitQuat, scratchMatrix);

  // 基準オフセット: ローカル北方向に -distance (北から model を見る)
  Cesium.Cartesian3.multiplyByScalar(localNorth, -distance, scratchOffset);
  Cesium.Matrix3.multiplyByVector(scratchMatrix, scratchOffset, scratchRotatedOffset);
  Cesium.Cartesian3.add(modelPosition, scratchRotatedOffset, scratchCameraPos);

  // 視線方向: カメラ → モデル
  Cesium.Cartesian3.subtract(modelPosition, scratchCameraPos, scratchDirection);
  Cesium.Cartesian3.normalize(scratchDirection, scratchDirection);

  // アップベクトル: ローカルアップをクオータニオンで回転
  Cesium.Matrix3.multiplyByVector(scratchMatrix, localUp, scratchUp);

  // グラム・シュミット直交化: right = dir × up, up = right × dir
  // これで真上/真下でも direction と up の直交性が保証され、
  // setView の内部再直交化による特異点ジッタを回避できる
  Cesium.Cartesian3.cross(scratchDirection, scratchUp, scratchRight);
  Cesium.Cartesian3.normalize(scratchRight, scratchRight);
  Cesium.Cartesian3.cross(scratchRight, scratchDirection, scratchUp);
  Cesium.Cartesian3.normalize(scratchUp, scratchUp);

  // setView を経由せずカメラプロパティに直接書き込む
  Cesium.Cartesian3.clone(scratchCameraPos,  viewer.camera.position);
  Cesium.Cartesian3.clone(scratchDirection,  viewer.camera.direction);
  Cesium.Cartesian3.clone(scratchUp,         viewer.camera.up);
  Cesium.Cartesian3.clone(scratchRight,      viewer.camera.right);
}

function applyRotation(dx, dy) {
  const yawAngle = -dx * ROTATE_SPEED;
  const pitchAngle = -dy * ROTATE_SPEED;

  // アークボール方式: ヨー軸もピッチ軸も "カメラ現在の姿勢" を基準にとる
  // これによって真上・真下でもデッドゾーンが発生しない
  Cesium.Matrix3.fromQuaternion(orbitQuat, scratchMatrix);

  // 現在のカメラ up (回転後の localUp)
  Cesium.Matrix3.multiplyByVector(scratchMatrix, localUp, scratchUp);
  Cesium.Cartesian3.normalize(scratchUp, scratchUp);
  Cesium.Quaternion.fromAxisAngle(scratchUp, yawAngle, scratchYawQuat);

  // 現在のカメラ right (回転後の localEast)
  Cesium.Matrix3.multiplyByVector(scratchMatrix, localEast, scratchRight);
  Cesium.Cartesian3.normalize(scratchRight, scratchRight);
  Cesium.Quaternion.fromAxisAngle(scratchRight, pitchAngle, scratchPitchQuat);

  // orbitQuat = yaw * pitch * orbitQuat
  Cesium.Quaternion.multiply(scratchPitchQuat, orbitQuat, orbitQuat);
  Cesium.Quaternion.multiply(scratchYawQuat, orbitQuat, orbitQuat);
  Cesium.Quaternion.normalize(orbitQuat, orbitQuat);
}

function applyZoom(dy) {
  const factor = 1.0 + dy * ZOOM_SPEED;
  distance *= factor;
  if (distance < MIN_DISTANCE) distance = MIN_DISTANCE;
  if (distance > MAX_DISTANCE) distance = MAX_DISTANCE;
}

function resetCamera() {
  // 東軸まわりに負のピッチをかけて "少し斜め上" から見下ろす姿勢に
  Cesium.Quaternion.fromAxisAngle(localEast, INIT_PITCH, orbitQuat);
  distance = INIT_DISTANCE;
  updateCamera();
}

// 入力ハンドリング: Cesium.ScreenSpaceEventHandler で完結させる
const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);

let mode = null; // 'rotate' | 'zoom' | null
const lastPos = new Cesium.Cartesian2();

handler.setInputAction((movement) => {
  mode = 'rotate';
  Cesium.Cartesian2.clone(movement.position, lastPos);
}, Cesium.ScreenSpaceEventType.LEFT_DOWN);

handler.setInputAction((movement) => {
  mode = 'zoom';
  Cesium.Cartesian2.clone(movement.position, lastPos);
}, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

handler.setInputAction((movement) => {
  if (!mode) return;
  const dx = movement.endPosition.x - lastPos.x;
  const dy = movement.endPosition.y - lastPos.y;
  Cesium.Cartesian2.clone(movement.endPosition, lastPos);

  if (mode === 'rotate') {
    applyRotation(dx, dy);
  } else if (mode === 'zoom') {
    applyZoom(dy);
  }
  updateCamera();
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

handler.setInputAction(() => {
  mode = null;
}, Cesium.ScreenSpaceEventType.LEFT_UP);

handler.setInputAction(() => {
  mode = null;
}, Cesium.ScreenSpaceEventType.RIGHT_UP);

handler.setInputAction((delta) => {
  applyZoom(-delta * 0.005);
  updateCamera();
}, Cesium.ScreenSpaceEventType.WHEEL);

resetCamera();

// モデル切替 UI
const selectEl = document.getElementById('modelSelect');
if (selectEl) {
  for (let i = 0; i < MODELS.length; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = MODELS[i].name;
    selectEl.appendChild(opt);
  }
  selectEl.addEventListener('change', (e) => {
    const idx = Number(e.target.value);
    loadModel(MODELS[idx].uri);
    resetCamera();
  });
}
