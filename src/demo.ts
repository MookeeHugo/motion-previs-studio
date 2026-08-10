import type {
  AnalysisManifest,
  CameraMotionData,
  Landmark,
  MediaInfo,
  MotionKeyframe,
  MotionPlanBlueprint,
  PoseData,
  PoseFrame
} from './types';

export const DEMO_SOURCE_PATH = 'demo://rain-night-lighthouse-action-previs';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 12;
const DURATION = 16.8;
const DEMO_REFERENCE_URL = demoFrameSvg('reference');
const DEMO_DEPTH_URL = demoFrameSvg('depth');
const DEMO_EDGES_URL = demoFrameSvg('edges');
const DEMO_MASK_URL = demoFrameSvg('mask');
const DEMO_NORMALS_URL = demoFrameSvg('normals');

export type LighthouseActionDemo = {
  source: MediaInfo;
  analysis: AnalysisManifest;
  poseData: PoseData;
  cameraMotionData: CameraMotionData;
  blueprint: MotionPlanBlueprint;
};

export function buildLighthouseActionDemo(): LighthouseActionDemo {
  const blueprint = buildBlueprint();
  return {
    source: {
      filePath: DEMO_SOURCE_PATH,
      url: DEMO_REFERENCE_URL,
      name: '雨夜灯塔动作段落.motionprevis',
      duration: DURATION,
      width: WIDTH,
      height: HEIGHT,
      frameRate: 24,
      videoCodec: 'demo-previs',
      audioCodec: null,
      sizeBytes: 0
    },
    analysis: {
      analysisId: `demo-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      sourcePath: DEMO_SOURCE_PATH,
      sourceName: '雨夜灯塔动作段落',
      range: { start: 0, end: DURATION, duration: DURATION },
      sampleFps: FPS,
      outputDir: 'demo://output/雨夜灯塔动作预演包',
      referencePath: DEMO_SOURCE_PATH,
      referenceUrl: DEMO_REFERENCE_URL,
      depthPath: 'demo://layers/depth.svg',
      depthUrl: DEMO_DEPTH_URL,
      edgesPath: 'demo://layers/edges.svg',
      edgesUrl: DEMO_EDGES_URL,
      lineartPath: 'demo://layers/lineart.svg',
      lineartUrl: DEMO_EDGES_URL,
      motionMaskPath: 'demo://layers/motion-mask.svg',
      motionMaskUrl: DEMO_MASK_URL,
      normalsPath: 'demo://layers/normals.svg',
      normalsUrl: DEMO_NORMALS_URL,
      animaticPath: 'demo://layers/animatic.svg',
      animaticUrl: DEMO_REFERENCE_URL,
      contactSheetPath: 'demo://layers/contact-sheet.svg',
      contactSheetUrl: DEMO_REFERENCE_URL,
      previewPath: 'demo://preview/reference.svg',
      previewUrl: DEMO_REFERENCE_URL,
      frameSize: { width: WIDTH, height: HEIGHT },
      status: 'demo-ready'
    },
    poseData: buildSyntheticPoseData(DURATION, FPS, WIDTH, HEIGHT),
    cameraMotionData: buildSyntheticCameraMotion(DURATION, FPS, WIDTH, HEIGHT),
    blueprint
  };
}

export function buildSyntheticPoseData(duration = DURATION, fps = FPS, width = WIDTH, height = HEIGHT): PoseData {
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const frames: PoseFrame[] = Array.from({ length: totalFrames }, (_, index) => {
    const time = index / fps;
    const phase = totalFrames <= 1 ? 0 : index / (totalFrames - 1);
    const landmarks = buildLandmarks(phase);
    const zhouLandmarks = transformLandmarks(landmarks, 0.22 - phase * 0.07, 0.035, 0.92, -0.025);
    const maLandmarks = transformLandmarks(landmarks, 0.38 - phase * 0.13, -0.035, 0.82, 0.035);
    const worldLandmarks = toWorldLandmarks(landmarks);
    return {
      time,
      landmarks,
      worldLandmarks,
      score: 0.86 + Math.sin(phase * Math.PI) * 0.06,
      poses: [
        { id: 0, landmarks, worldLandmarks, score: 0.9 },
        { id: 1, landmarks: zhouLandmarks, worldLandmarks: toWorldLandmarks(zhouLandmarks), score: 0.84 },
        { id: 2, landmarks: maLandmarks, worldLandmarks: toWorldLandmarks(maLandmarks), score: 0.8 }
      ],
      source: index % 17 === 0 ? 'filled' : 'detected',
      filled: index % 17 === 0
    };
  });

  return {
    fps,
    duration,
    width,
    height,
    frames,
    summary: {
      totalFrames,
      detectedFrames: totalFrames,
      rawDetectedFrames: totalFrames - Math.ceil(totalFrames / 17),
      filledFrames: Math.ceil(totalFrames / 17),
      missingFrames: 0,
      lowConfidenceFrames: 0,
      maxPeopleDetected: 3,
      averageScore: 0.88,
      motionEnergy: 0.043,
      diagnostics: [
        '中文示例轨迹已加载：主角冲刺、侧身闪避、近身争夺三个动作段落。',
        '关键帧节奏完整：可直接调整镜头编号、动作节拍、摄影机运动和风险备注。',
        '本地演示数据不会上传云端，适合用作动作预演模板。'
      ]
    }
  };
}

export function buildSyntheticCameraMotion(duration = DURATION, fps = FPS, width = WIDTH, height = HEIGHT): CameraMotionData {
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const frames = Array.from({ length: totalFrames }, (_, index) => {
    const time = index / fps;
    const phase = totalFrames <= 1 ? 0 : index / (totalFrames - 1);
    const rush = Math.sin(phase * Math.PI);
    return {
      time,
      frameIndex: index,
      imageMotion: {
        xPixels: -82 + phase * 168,
        yPixels: 34 * Math.sin(phase * Math.PI * 2),
        scale: 1 + rush * 0.18,
        rollRadians: (-2.5 + 5 * phase) * (Math.PI / 180)
      },
      cameraMove: {
        pan: -0.42 + phase * 0.88,
        tilt: -0.09 + Math.sin(phase * Math.PI * 1.5) * 0.22,
        dollyZoom: 1 + rush * 0.26,
        roll: -2.5 + 5 * phase
      },
      confidence: 0.78 + rush * 0.16
    };
  });

  return {
    fps,
    duration,
    width,
    height,
    frames,
    summary: {
      panPixels: 168,
      tiltPixels: 34,
      zoomRatio: 1.26,
      rollDegrees: 5,
      averageConfidence: 0.86
    }
  };
}

function buildBlueprint(): MotionPlanBlueprint {
  const keyframes: MotionKeyframe[] = [
    keyframe('KF-01', 'A01', 0, 2.2, '雨刷切入海雾', '黑车沿沿海公路压线驶入，远处灯塔光束扫过车窗。', '85mm 长焦压缩海岸线，车载低机位轻微震动。', '长焦 / 车载低机位', '中高速', '雨声压迫', '硬切入追车段落', '车距与湿滑路面需要安全车控。'),
    keyframe('KF-02', 'A02', 2.2, 2.4, '贴近车门横移', '周岚从副驾侧探身拍摄，林澈车辆从画外逼近。', '稳定器贴车门横移，保持车灯反光在画面右侧。', '35mm 稳定器', '横移 1.8m/s', '紧张升级', '水花擦镜转场', '演员靠近车门，需限位线。'),
    keyframe('KF-03', 'A03', 4.6, 2.0, '急刹甩尾', '车辆在灯塔下方急刹，后轮打滑，档案包跌落。', '手持跟随甩尾，镜头延迟半拍再补偿回中心。', '28mm 手持', '减速至停', '失控感', '甩尾带出灯塔', '湿地面、道具滑行需封控。'),
    keyframe('KF-04', 'B01', 6.6, 1.9, '林澈冲出车门', '林澈推门冲向灯塔台阶，周岚绕车追拍。', '低机位从车轮前方后撤，角色越过镜头近前景。', '24mm 低机位后撤', '冲刺 3.2m/s', '爆发', '角色遮挡擦切', '车门开合与跑位错峰。'),
    keyframe('KF-05', 'B02', 8.5, 2.1, '台阶近身争夺', '二人在湿滑台阶争夺档案包，老马从右后方出现。', '环绕 110 度，镜头贴近肩部，焦点从包切到老马。', '40mm 环绕 + 拉焦', '环绕 2.4m/s', '威胁显形', '拉焦转场', '台阶防滑、近身动作需套招。'),
    keyframe('KF-06', 'C01', 10.6, 2.0, '灯塔光扫过脸', '灯塔光束扫过三人脸部，林澈停顿，周岚后退半步。', '摄影机从肩后升至中近景，灯光过脸时做微推。', '50mm 肩后升降', '慢推', '真相浮出', '灯光扫过做节拍点', '强光扫演员眼部需控亮度。'),
    keyframe('KF-07', 'C02', 12.6, 2.0, '老马拔出信号枪', '老马抬手亮出信号枪，海浪声吞掉对白。', '快速推近到手部，再上摇到眼神，保留枪口安全方向。', '65mm 推近上摇', '快速推近', '危险临界', '动作点上摇', '道具枪只作假枪处理，枪口方向锁定。'),
    keyframe('KF-08', 'D01', 14.6, 2.2, '拉开见全局', '信号弹照亮礁石平台，三人站位形成三角对峙。', '无人机式后拉升高，露出灯塔、海浪、车辆和安全通道。', '24mm 后拉升高', '后拉 4.5m/s', '悬念释放', '白光溶切收段', '升降机/无人机替代方案需确认场地。')
  ];

  return {
    id: 'rain-night-lighthouse',
    projectTitle: '雨夜灯塔：沿海追车到灯塔冲突',
    sceneTitle: '沿海公路 / 灯塔外礁石平台 / 暴雨夜',
    shotTitle: 'A01-D01 动作段落总预演',
    sourceName: '雨夜灯塔动作段落.motionprevis',
    duration: DURATION,
    fps: 24,
    frameSize: { width: WIDTH, height: HEIGHT },
    logline: '一段从沿海公路追车转入灯塔台阶近身争夺的动作预演，重点控制角色位移、摄影机动势、转场节拍和片场风险。',
    creativeIntent: '用可编辑关键帧把追车、下车冲刺、台阶争夺、信号枪亮相串成一个连续动作段落；每个镜头都标明动作节拍、摄影机运动、速度/时长和风险备注。',
    visualStyle: '雨夜、蓝灰海雾、灯塔逆光、车灯反射、手持与稳定器混合；动作段落强调速度变化、呼吸点和情绪节拍。',
    subjects: [
      {
        id: 'ACT-01',
        name: '林澈 / 灯塔守望人',
        role: '主动追击者',
        path: '车门 -> 台阶左侧 -> 中央争夺点 -> 灯塔门前',
        speed: '冲刺 3.2m/s，近身段降至 0.7m/s',
        risk: '雨地冲刺、防滑鞋、车门与演员安全距离'
      },
      {
        id: 'ACT-02',
        name: '周岚 / 纪录片导演',
        role: '被追逐与记录者',
        path: '副驾侧 -> 绕车 -> 台阶右侧 -> 后撤半步',
        speed: '横移 1.8m/s，后撤 0.9m/s',
        risk: '手持摄影机道具重量、倒退走位需保护员'
      },
      {
        id: 'ACT-03',
        name: '老马 / 船工',
        role: '第三方威胁',
        path: '灯塔右后方阴影 -> 台阶平台 -> 信号枪亮相',
        speed: '潜伏慢走 0.6m/s，亮相停顿 1.2s',
        risk: '道具枪安全方向、强光与演员眼部保护'
      },
      {
        id: 'VEH-01',
        name: '黑色越野车',
        role: '追车动势来源',
        path: '沿海公路外侧 -> 急刹甩尾 -> 灯塔下方停靠',
        speed: '入画 38km/h，急刹至停',
        risk: '封控路段、湿滑路面、车辆特技需低速拍高能'
      }
    ],
    keyframes,
    shots: [
      { id: 'A01-A03', title: '追车到急刹', duration: 6.6, camera: '车载低机位 + 手持补偿', action: '车灯、水花、甩尾把外部动势推到灯塔空间。', emotion: '压迫、失控、逼近' },
      { id: 'B01-B02', title: '下车冲刺到台阶争夺', duration: 4.0, camera: '低机位后撤 + 110 度环绕', action: '角色位移从直线冲刺转为近身环绕，动作密度最高。', emotion: '爆发、威胁显形' },
      { id: 'C01-C02', title: '灯塔光束与信号枪', duration: 4.0, camera: '肩后升降 + 手部推近上摇', action: '动作暂停半拍，让灯光和道具成为情绪节拍。', emotion: '真相、危险临界' },
      { id: 'D01', title: '后拉全局', duration: 2.2, camera: '后拉升高，露出三角站位', action: '从近身动作抽离到空间关系，为下一场冲突留悬念。', emotion: '悬念释放' }
    ],
    actionNodes: [
      { id: 'N01', label: '车灯压入', time: 0.8, note: '灯塔光束第一次扫过车窗。' },
      { id: 'N02', label: '急刹甩尾', time: 4.9, note: '车辆停，外部动势转为人物动作。' },
      { id: 'N03', label: '档案包落地', time: 5.7, note: '道具成为争夺目标。' },
      { id: 'N04', label: '台阶争夺', time: 8.9, note: '动作密度最高，镜头环绕。' },
      { id: 'N05', label: '灯塔光过脸', time: 11.2, note: '情绪停顿，露出隐瞒信息。' },
      { id: 'N06', label: '信号枪亮相', time: 13.0, note: '危险道具入画，声画节奏压低。' },
      { id: 'N07', label: '信号弹照亮', time: 15.2, note: '白光转场，空间关系打开。' }
    ],
    transitions: ['水花擦镜', '角色遮挡擦切', '拉焦转场', '灯塔光束扫过', '信号弹白光溶切'],
    riskNotes: [
      '湿滑路面和台阶必须预铺防滑材料，冲刺镜头安排保护员。',
      '车戏按低速拍摄、高动势镜头语言处理，不做危险高速追逐。',
      '信号枪为安全道具，枪口方向、演员眼部强光和烟雾量需现场确认。',
      '后拉升高镜头预留摇臂/无人机/虚拟摄影机三套替代方案。'
    ]
  };
}

function keyframe(
  id: string,
  shot: string,
  time: number,
  duration: number,
  beat: string,
  actorMove: string,
  cameraMove: string,
  lens: string,
  speed: string,
  emotion: string,
  transition: string,
  risk: string
): MotionKeyframe {
  return { id, shot, time, duration, beat, actorMove, cameraMove, lens, speed, emotion, transition, risk };
}

function buildLandmarks(phase: number): Landmark[] {
  const sway = Math.sin(phase * Math.PI * 4) * 0.018;
  const stride = Math.sin(phase * Math.PI * 8) * 0.035;
  const crouch = phase > 0.48 && phase < 0.64 ? 0.045 : 0;
  const centerX = 0.48 + (phase - 0.5) * 0.18 + sway;
  const centerY = 0.52 + crouch;
  const z = Math.sin(phase * Math.PI * 2) * 0.06;

  const p = (x: number, y: number, depth = z, visibility = 0.9): Landmark => ({
    x: centerX + x,
    y: centerY + y,
    z: depth,
    visibility
  });

  const points: Landmark[] = [
    p(0, -0.32, z, 0.95),
    p(-0.012, -0.35),
    p(-0.026, -0.35),
    p(-0.04, -0.35),
    p(0.012, -0.35),
    p(0.026, -0.35),
    p(0.04, -0.35),
    p(-0.058, -0.325),
    p(0.058, -0.325),
    p(-0.024, -0.292),
    p(0.024, -0.292),
    p(-0.11, -0.18),
    p(0.11, -0.18),
    p(-0.17 - stride * 0.4, -0.015),
    p(0.16 + stride * 0.2, -0.035),
    p(-0.2 - stride, 0.13),
    p(0.19 + stride, 0.11),
    p(-0.215 - stride, 0.15),
    p(0.205 + stride, 0.13),
    p(-0.205 - stride, 0.18),
    p(0.195 + stride, 0.16),
    p(-0.18 - stride, 0.18),
    p(0.17 + stride, 0.16),
    p(-0.075, 0.12),
    p(0.075, 0.12),
    p(-0.1 + stride, 0.35),
    p(0.1 - stride, 0.35),
    p(-0.11 + stride * 1.2, 0.58),
    p(0.11 - stride * 1.2, 0.58),
    p(-0.12 + stride * 1.2, 0.62),
    p(0.12 - stride * 1.2, 0.62),
    p(-0.145 + stride * 1.3, 0.62),
    p(0.145 - stride * 1.3, 0.62)
  ];

  return points.map((point) => ({
    ...point,
    x: clamp(point.x, 0.08, 0.92),
    y: clamp(point.y, 0.08, 0.96)
  }));
}

function transformLandmarks(points: Landmark[], dx: number, dy: number, scale: number, dz: number): Landmark[] {
  return points.map((point) => ({
    ...point,
    x: clamp(0.5 + (point.x - 0.5) * scale + dx, 0.06, 0.94),
    y: clamp(0.52 + (point.y - 0.52) * scale + dy, 0.08, 0.96),
    z: point.z + dz,
    visibility: Math.max(0.55, (point.visibility ?? 0.9) - 0.08)
  }));
}

function toWorldLandmarks(points: Landmark[]): Landmark[] {
  return points.map((point) => ({
    x: (point.x - 0.5) * 2.2,
    y: (0.72 - point.y) * 2.3,
    z: point.z * 1.5,
    visibility: point.visibility
  }));
}

function demoFrameSvg(kind: 'reference' | 'depth' | 'edges' | 'mask' | 'normals'): string {
  const titles = {
    reference: '雨夜灯塔 / 沿海追车到灯塔冲突',
    depth: '深度层：灯塔、车辆、台阶空间',
    edges: '边缘层：车灯、水花、人物轮廓',
    mask: '动作遮罩：角色与载具位移',
    normals: '法线参考：地面、台阶、灯塔体块'
  };
  const palettes = {
    reference: ['#081018', '#102d3a', '#f6c85f', '#9bd7ff'],
    depth: ['#05070b', '#22325f', '#6ea8ff', '#e7f0ff'],
    edges: ['#030507', '#0a1014', '#dff9ff', '#ffda78'],
    mask: ['#07070a', '#2b1020', '#ff5f87', '#79f2ff'],
    normals: ['#07100d', '#163024', '#72d88f', '#7fb7ff']
  };
  const [bg, mid, accent, cool] = palettes[kind];
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg}"/>
      <stop offset="0.62" stop-color="${mid}"/>
      <stop offset="1" stop-color="#020304"/>
    </linearGradient>
    <radialGradient id="lamp" cx="38%" cy="19%" r="48%">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.92"/>
      <stop offset="0.26" stop-color="${accent}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="7"/></filter>
  </defs>
  <rect width="1280" height="720" fill="url(#sky)"/>
  <path d="M0 500 C210 430 348 474 526 428 C742 371 866 430 1280 338 L1280 720 L0 720 Z" fill="#06090b"/>
  <path d="M0 568 C220 528 418 566 640 530 C868 493 1030 523 1280 480 L1280 720 L0 720 Z" fill="#0a1115"/>
  <path d="M160 598 C365 532 635 532 1058 596" stroke="${cool}" stroke-width="18" opacity="0.18" fill="none"/>
  <g transform="translate(408 112)">
    <path d="M36 390 L86 390 L74 86 L48 86 Z" fill="#d9e2e6" opacity="0.72"/>
    <path d="M42 86 L80 86 L72 52 L50 52 Z" fill="#f4efe1"/>
    <circle cx="61" cy="49" r="22" fill="${accent}"/>
    <path d="M60 49 L1110 190" stroke="${accent}" stroke-width="54" opacity="0.13" filter="url(#blur)"/>
    <path d="M60 49 L1110 190" stroke="${accent}" stroke-width="18" opacity="0.38"/>
  </g>
  <g transform="translate(720 455) rotate(-8)">
    <rect x="-154" y="-44" width="308" height="82" rx="22" fill="#050608" stroke="${cool}" stroke-width="5"/>
    <rect x="-110" y="-73" width="135" height="45" rx="12" fill="#11191f"/>
    <circle cx="-95" cy="50" r="31" fill="#07090b" stroke="#3b464d" stroke-width="8"/>
    <circle cx="98" cy="50" r="31" fill="#07090b" stroke="#3b464d" stroke-width="8"/>
    <path d="M145 -15 L232 -34" stroke="${accent}" stroke-width="16" stroke-linecap="round"/>
    <path d="M146 9 L244 12" stroke="${accent}" stroke-width="10" stroke-linecap="round" opacity="0.55"/>
  </g>
  <g stroke="${cool}" stroke-width="9" stroke-linecap="round" fill="none" opacity="0.92">
    <path d="M520 488 C570 438 620 420 690 398"/>
    <path d="M675 398 C740 372 806 388 878 360"/>
    <path d="M500 520 C616 500 760 493 914 448"/>
  </g>
  <g fill="${accent}" opacity="0.9">
    <circle cx="520" cy="488" r="10"/>
    <circle cx="690" cy="398" r="10"/>
    <circle cx="878" cy="360" r="10"/>
    <circle cx="914" cy="448" r="10"/>
  </g>
  <g font-family="Microsoft YaHei, PingFang SC, sans-serif" fill="#eef7f8">
    <text x="58" y="72" font-size="34" font-weight="700">${titles[kind]}</text>
    <text x="60" y="116" font-size="20" fill="#b7cbd0">镜头 A01-D01 · 16.8 秒 · 8 个关键帧 · 7 个动作节点</text>
    <text x="60" y="650" font-size="22" fill="${accent}">本地 demo 预演层：可编辑关键帧、角色位移、摄影机运动、速度/时长与风险备注</text>
  </g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
