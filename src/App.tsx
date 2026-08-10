// Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md.

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Box,
  Camera,
  CheckCircle2,
  Clapperboard,
  Cpu,
  Download,
  FileArchive,
  FileVideo,
  FolderOpen,
  Gauge,
  HelpCircle,
  Image as ImageIcon,
  Info,
  Layers3,
  Link,
  Maximize2,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Save,
  Scissors,
  Send,
  Settings2,
  SkipBack,
  SkipForward,
  Square,
  SquareStack,
  Upload,
  X,
  Youtube
} from 'lucide-react';
import type {
  AnalysisManifest,
  AppInfo,
  CameraMotionData,
  ControlLayerKey,
  ExportPreset,
  ExportResolution,
  ExportResult,
  MediaInfo,
  MotionKeyframe,
  MotionPlanBlueprint,
  PlanningData,
  PoseAnalysisSettings,
  PoseData,
  PoseFrame,
  PoseModelKey,
  ProjectSession,
  QualityReport,
  SavedSession,
  SubjectMode
} from './types';
import { isCancelledError } from './types';
import type {
  ControlSettingsPatch,
  ControlState,
  MpsControlSurface,
  SendToBlockoutWhich
} from './control/registry';
import { createAiDepthVideoBlob } from './lib/aiDepth';
import { analyzeCameraMotionVideo } from './lib/cameraMotion';
import { buildOpenPoseJson, renderOpenPoseFrames } from './lib/openpose';
import {
  DEFAULT_POSE_SETTINGS,
  DEPTH_MODEL_OPTIONS,
  POSE_CONNECTIONS,
  POSE_MODEL_OPTIONS,
  analyzePoseVideo,
  poseConnectionColor
} from './lib/pose';
import { createPoseVideoBlob } from './lib/poseVideo';
import { isFrameEncoderAvailable } from './lib/frameEncoder';
import { computeQualityReport, layerScore, trackingScore } from './lib/quality';
import { buildRelinkedSession, sessionRestoreRequest, type SessionRestoreRequest } from './lib/sessionRestore';
import { ThreePreview } from './components/ThreePreview';
import { DEMO_SOURCE_PATH, buildLighthouseActionDemo, buildSyntheticCameraMotion, buildSyntheticPoseData } from './demo';
import logoUrl from './assets/logo.png';

type Stage = 'idle' | 'importing' | 'preparing' | 'tracking' | 'ready' | 'exporting' | 'exported' | 'error';
const APP_TITLE = `Motion Previs Studio v${__MPS_APP_VERSION__}`;

// The five real analysis/export stages surfaced in the progress rail. Each maps
// to callbacks that already exist in the lib layer.
type StageKey = 'prepare' | 'pose' | 'camera' | 'encode' | 'bundle';
const STAGE_STEPS: { key: StageKey; label: string }[] = [
  { key: 'prepare', label: '准备' },
  { key: 'pose', label: '姿态' },
  { key: 'camera', label: '摄影机' },
  { key: 'encode', label: '编码' },
  { key: 'bundle', label: '打包' }
];

const CONTROL_LAYERS: { key: ControlLayerKey; label: string }[] = [
  { key: 'depth', label: '深度' },
  { key: 'ai-depth', label: 'AI 深度' },
  { key: 'pose', label: '姿态' },
  { key: 'camera', label: '摄影机' },
  { key: 'edges', label: '边缘' },
  { key: 'lineart', label: '线稿' },
  { key: 'masks', label: '动作遮罩' },
  { key: 'normals', label: '法线' }
];

const EXPORT_PRESETS: { key: ExportPreset; label: string }[] = [
  { key: 'seedance', label: 'Seedance' },
  { key: 'comfyui', label: 'ComfyUI' },
  { key: 'blender', label: 'Blender' },
  { key: 'runway', label: 'Runway' },
  { key: 'kling', label: 'Kling' }
];

const WORKFLOW_STEPS = ['素材', '分析', '规划', '导出'];

// The single Reference Mode control: four explicit options, each with a one-line
// explainer, mapping straight onto the subjectMode state.
const REFERENCE_MODES: { key: SubjectMode; label: string; hint: string }[] = [
  { key: 'camera-only', label: '仅摄影机', hint: '保留摄影机运动、时长与节奏，替换人物和场景。' },
  { key: 'actor-motion', label: '角色动作', hint: '保留身体姿态、动作节拍和摄影机运动。' },
  { key: 'object-motion', label: '载具/道具', hint: '保留车辆、道具或物体路径，并同步镜头动势。' },
  { key: 'full-scene', label: '完整场景', hint: '保留摄影机、走位、主体运动和深度节奏。' }
];

const PRESET_ACCENTS: Record<ExportPreset, string> = {
  seedance: '#3ee3d2',
  comfyui: '#9e7cff',
  blender: '#ff932e',
  runway: '#47e571',
  kling: '#45c8ff'
};

const CREDIT_LINE = 'BloomReel Team · BloomReel AI Filmmaker Studio · Proprietary';

type Toast = { id: number; text: string; tone: 'ok' | 'error' };

const STAGE_LABELS: Record<Stage, string> = {
  idle: '待分析',
  importing: '导入中',
  preparing: '准备中',
  tracking: '跟踪中',
  ready: '可导出',
  exporting: '导出中',
  exported: '已导出',
  error: '需处理'
};

const QUALITY_LABELS: Record<QualityReport['readiness'] | QualityReport['tracking'], string> = {
  Missing: '缺失',
  Review: '需复核',
  Good: '良好',
  Excellent: '优秀',
  Blocked: '阻塞',
  Ready: '可交付'
};

// The action half of the agent-control surface (the state half is ControlState).
// Held in a ref and updated each render so window.__mps calls the current flows.
type MpsControlActions = Omit<MpsControlSurface, 'getState'>;

export function App() {
  const [source, setSource] = useState<MediaInfo | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisManifest | null>(null);
  const [poseData, setPoseData] = useState<PoseData | null>(null);
  const [cameraMotionData, setCameraMotionData] = useState<CameraMotionData | null>(null);
  const [motionBlueprint, setMotionBlueprint] = useState<MotionPlanBlueprint | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [url, setUrl] = useState('');
  const [range, setRange] = useState({ start: 0, end: 8 });
  const [sampleFps, setSampleFps] = useState(12);
  const [resolution, setResolution] = useState<ExportResolution>('auto');
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [activeStage, setActiveStage] = useState<StageKey | null>(null);
  const [message, setMessage] = useState('导入参考视频，或一键加载中文动作预演示例。');
  const [error, setError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [poseSettings, setPoseSettings] = useState<PoseAnalysisSettings>(DEFAULT_POSE_SETTINGS);
  const [useCameraMove, setUseCameraMove] = useState(true);
  const [projectTitle, setProjectTitle] = useState('未命名动作预演项目');
  const [sceneTitle, setSceneTitle] = useState('场次 01');
  const [shotTitle, setShotTitle] = useState('镜头 01A');
  const [creativeIntent, setCreativeIntent] = useState('保留参考镜头的运动节奏、动作节点和摄影机动势，用于中文影视动作预演。');
  const [visualStyle, setVisualStyle] = useState('本地优先的动态分镜：关键帧清楚、角色位移明确、摄影机运动可复盘。');
  const [subjectMode, setSubjectMode] = useState<SubjectMode>('camera-only');
  const [selectedLayers, setSelectedLayers] = useState<ControlLayerKey[]>(['depth', 'ai-depth', 'pose', 'camera', 'edges', 'masks']);
  const [exportPresets, setExportPresets] = useState<ExportPreset[]>(['seedance', 'comfyui', 'blender']);
  const [showHelp, setShowHelp] = useState(false);
  const [blockoutAvailable, setBlockoutAvailable] = useState(false);
  const [restorePrompt, setRestorePrompt] = useState<SessionRestoreRequest | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const appDisplayName = appInfo?.displayName || APP_TITLE;
  const referenceVideoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const toastId = useRef(0);
  // Latest snapshot + action implementations for the agent-control surface
  // (window.__mps). Updated every render so the MCP handler always sees current
  // state and calls into the same flows the UI uses.
  const controlRef = useRef<{ state: ControlState; actions: MpsControlActions } | null>(null);
  // Guards a one-time settings restore so a load doesn't fight fresh edits.
  const restoredRef = useRef(false);

  useEffect(() => {
    window.motionPrevis?.getVersions().then(setVersions).catch(() => undefined);
    window.motionPrevis?.getAppInfo().then(setAppInfo).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.title = appDisplayName;
  }, [appDisplayName]);

  // Offer to restore the last session on launch.
  useEffect(() => {
    let cancelled = false;
    window.motionPrevis
      ?.loadSession()
      .then((session) => {
        if (cancelled || !session) return;
        // Restore settings silently, then offer either a normal restore or a
        // relink when the machine-local media path has moved/disappeared.
        applySessionSettings(session);
        setRestorePrompt(sessionRestoreRequest(session));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll whether Blockout is reachable so the Send button reflects reality.
  useEffect(() => {
    let alive = true;
    const check = () => {
      window.motionPrevis
        ?.blockoutStatus()
        .then((status) => {
          if (alive) setBlockoutAvailable(Boolean(status?.available));
        })
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const duration = source?.duration || 0;
  const selectedDuration = Math.max(0.1, range.end - range.start);
  const useAiDepth = poseSettings.depthModel === 'depth-anything';
  const currentPoseFrame = useMemo(() => selectPoseFrame(poseData, currentTime), [currentTime, poseData]);

  const qualityReport = useMemo(() => {
    const totalFrames = poseData?.frames.length || 0;
    const rawDetected = poseData?.summary.rawDetectedFrames ?? poseData?.summary.detectedFrames ?? 0;
    const filled = poseData?.summary.filledFrames || 0;
    const tracking = trackingScore(rawDetected, filled, totalFrames);
    const camera = useCameraMove ? cameraMotionData?.summary.averageConfidence || 0 : 0;
    const layers = analysis ? layerScore(selectedLayers.length) : 0;
    return computeQualityReport({
      tracking,
      camera,
      layers,
      cameraActive: useCameraMove,
      rawDetectedFrames: rawDetected,
      totalFrames,
      filledFrames: filled
    });
  }, [analysis, cameraMotionData, poseData, selectedLayers, useCameraMove]);

  const planningData = useMemo<PlanningData>(
    () => ({
      projectTitle: projectTitle.trim() || '未命名动作预演项目',
      sceneTitle: sceneTitle.trim() || '场次 01',
      shotTitle: shotTitle.trim() || '镜头 01A',
      creativeIntent: creativeIntent.trim() || '保留参考动作节奏和摄影机语言，用于新的 AI 影视镜头。',
      visualStyle: visualStyle.trim() || '专业中文动作预演。',
      subjectMode,
      selectedLayers,
      exportPresets,
      shotBible: [
        {
          id: 'shot-001',
          scene: sceneTitle.trim() || '场次 01',
          shot: shotTitle.trim() || '镜头 01A',
          description: creativeIntent.trim() || '由参考动作节奏生成的预演镜头。',
          duration: selectedDuration,
          subjectMode,
          cameraIntent: useCameraMove
            ? '复现参考中的横摇、俯仰、变焦、滚转和镜头节奏。'
            : '本轮关闭摄影机运动求解，仅保留动作节拍。',
          selected: true
        }
      ],
      qualityReport,
      analysisSettings: poseSettings
    }),
    [creativeIntent, exportPresets, projectTitle, qualityReport, sceneTitle, selectedDuration, selectedLayers, shotTitle, subjectMode, useCameraMove, visualStyle, poseSettings]
  );

  function pushToast(text: string, tone: 'ok' | 'error' = 'ok') {
    const id = (toastId.current += 1);
    setToasts((current) => [...current, { id, text, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }

  function applySessionSettings(session: SavedSession | ProjectSession, force = false) {
    if (restoredRef.current && !force) return;
    restoredRef.current = true;
    if (session.range) setRange({ start: session.range.start, end: session.range.end });
    if (typeof session.sampleFps === 'number') setSampleFps(session.sampleFps);
    if (session.subjectMode) setSubjectMode(session.subjectMode);
    if (session.poseSettings) setPoseSettings((current) => ({ ...current, ...session.poseSettings }));
    if (typeof session.useCameraMove === 'boolean') setUseCameraMove(session.useCameraMove);
    if (session.selectedLayers?.length) setSelectedLayers(session.selectedLayers);
    if (session.exportPresets?.length) setExportPresets(session.exportPresets);
    if (session.resolution) setResolution(session.resolution);
    if (session.planning?.projectTitle) setProjectTitle(session.planning.projectTitle);
    if (session.planning?.sceneTitle) setSceneTitle(session.planning.sceneTitle);
    if (session.planning?.shotTitle) setShotTitle(session.planning.shotTitle);
    if (session.planning?.creativeIntent) setCreativeIntent(session.planning.creativeIntent);
    if (session.planning?.visualStyle) setVisualStyle(session.planning.visualStyle);
  }

  const buildSession = useCallback((): ProjectSession => ({
    sourcePath: source?.filePath ?? null,
    sourceName: source?.name ?? null,
    range: { start: range.start, end: range.end },
    sampleFps,
    subjectMode,
    poseSettings,
    useCameraMove,
    selectedLayers,
    exportPresets,
    resolution,
    planning: {
      projectTitle,
      sceneTitle,
      shotTitle,
      creativeIntent,
      visualStyle
    },
    lastBundlePath: exportResult?.outputDir ?? null
  }), [source, range, sampleFps, subjectMode, poseSettings, useCameraMove, selectedLayers, exportPresets, resolution, projectTitle, sceneTitle, shotTitle, creativeIntent, visualStyle, exportResult]);

  async function saveProject() {
    try {
      if (!window.motionPrevis) throw new Error('桌面桥接不可用，无法保存项目。');
      await window.motionPrevis.saveSession(buildSession());
      pushToast('项目已保存到本机。');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  function sessionFromMedia(media: MediaInfo, nextRange = range): ProjectSession {
    return {
      sourcePath: media.filePath,
      sourceName: media.name,
      range: { start: nextRange.start, end: nextRange.end },
      sampleFps,
      subjectMode,
      poseSettings,
      useCameraMove,
      selectedLayers,
      exportPresets,
      resolution,
      planning: {
        projectTitle,
        sceneTitle,
        shotTitle,
        creativeIntent,
        visualStyle
      },
      lastBundlePath: exportResult?.outputDir ?? null
    };
  }

  function loadDemo(silent = false) {
    const demo = buildLighthouseActionDemo();
    setSource(demo.source);
    setAnalysis(demo.analysis);
    setPoseData(demo.poseData);
    setCameraMotionData(demo.cameraMotionData);
    setMotionBlueprint(demo.blueprint);
    setExportResult(null);
    setUrl('');
    setRange({ start: 0, end: demo.blueprint.duration });
    setSampleFps(12);
    setResolution('720p');
    setProjectTitle(demo.blueprint.projectTitle);
    setSceneTitle(demo.blueprint.sceneTitle);
    setShotTitle(demo.blueprint.shotTitle);
    setCreativeIntent(demo.blueprint.creativeIntent);
    setVisualStyle(demo.blueprint.visualStyle);
    setSubjectMode('full-scene');
    setSelectedLayers(['depth', 'ai-depth', 'pose', 'camera', 'edges', 'lineart', 'masks', 'normals']);
    setExportPresets(['seedance', 'comfyui', 'blender', 'kling']);
    setCurrentTime(0);
    setStage('ready');
    setProgress(0.86);
    setActiveStage(null);
    setError('');
    setMessage(`已加载中文示例：${demo.blueprint.keyframes.length} 个关键帧、${demo.blueprint.shots.length} 个镜头段落、${demo.blueprint.actionNodes.length} 个动作节点。`);
    restoredRef.current = true;
    void window.motionPrevis?.saveSession({
      sourcePath: demo.source.filePath,
      sourceName: demo.source.name,
      range: { start: 0, end: demo.blueprint.duration },
      sampleFps: 12,
      subjectMode: 'full-scene',
      poseSettings,
      useCameraMove: true,
      selectedLayers: ['depth', 'ai-depth', 'pose', 'camera', 'edges', 'lineart', 'masks', 'normals'],
      exportPresets: ['seedance', 'comfyui', 'blender', 'kling'],
      resolution: '720p',
      planning: {
        projectTitle: demo.blueprint.projectTitle,
        sceneTitle: demo.blueprint.sceneTitle,
        shotTitle: demo.blueprint.shotTitle,
        creativeIntent: demo.blueprint.creativeIntent,
        visualStyle: demo.blueprint.visualStyle
      },
      lastBundlePath: null
    }).catch(() => undefined);
    if (!silent) pushToast('已加载「雨夜灯塔」中文动作预演示例。');
  }

  // Persist settings quietly whenever they change (so restarts keep them) once a
  // source is loaded — avoids clobbering the on-disk session before restore.
  useEffect(() => {
    if (!restoredRef.current) return;
    const timer = window.setTimeout(() => {
      window.motionPrevis?.saveSession(buildSession()).catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [buildSession]);

  async function restoreLastSession() {
    const session = restorePrompt?.session;
    setRestorePrompt(null);
    if (!session?.sourcePath) return;
    if (session.sourcePath === DEMO_SOURCE_PATH) {
      loadDemo(true);
      pushToast('已恢复中文示例项目。');
      return;
    }
    if (!session.sourceUrl) return;
    // Re-probe the file through the bridge so we get fresh metadata + URL.
    try {
      setStage('importing');
      setMessage('正在恢复上次项目');
      // The main process already re-allowed the path; build a MediaInfo shell
      // and let prepareAnalysis re-probe on demand.
      const media: MediaInfo = {
        filePath: session.sourcePath,
        url: session.sourceUrl,
        name: session.sourceName || session.sourcePath.split(/[\\/]/).pop() || '素材',
        duration: session.range ? Math.max(session.range.end, 8) : 8,
        width: 0,
        height: 0,
        frameRate: 0,
        videoCodec: 'unknown',
        audioCodec: null,
        sizeBytes: 0
      };
      setSource(media);
      setMotionBlueprint(null);
      if (session.range) setRange({ start: session.range.start, end: session.range.end });
      setStage('idle');
      setMessage('上次项目已恢复，可继续运行分析。');
      pushToast('已恢复上次项目。');
    } catch (err) {
      fail(err);
    }
  }

  async function relinkLastSession() {
    const request = restorePrompt;
    if (!request || request.kind !== 'relink') return;
    try {
      if (!window.motionPrevis) throw new Error('桌面桥接不可用，无法重新关联素材。');
      setStage('importing');
      setMessage(`请重新定位 ${request.session.sourceName || '缺失素材'}`);
      const media = await window.motionPrevis.openMedia();
      if (!media) {
        setStage('idle');
        setMessage('已取消重新关联，保存的设置仍会保留。');
        return;
      }
      acceptSource(media);
      applySessionSettings(request.session, true);
      await window.motionPrevis.saveSession(buildRelinkedSession(request.session, media));
      setRestorePrompt(null);
      setMessage('素材已重新关联，可继续运行分析。');
      pushToast('项目素材已重新关联。');
    } catch (err) {
      fail(err);
    }
  }

  async function loadFile() {
    try {
      setStage('importing');
      setMessage('正在打开本地视频素材');
      if (!window.motionPrevis) throw new Error('桌面桥接不可用，无法打开素材。');
      const media = await window.motionPrevis.openMedia();
      if (!media) {
        setStage('idle');
        return;
      }
      acceptSource(media);
    } catch (err) {
      fail(err);
    }
  }

  async function loadUrl() {
    try {
      setStage('importing');
      setProgress(0.05);
      setMessage('正在载入网络视频链接');
      if (!window.motionPrevis) throw new Error('桌面桥接不可用，无法载入网络视频。');
      const media = await window.motionPrevis.importUrl(url.trim());
      acceptSource(media);
    } catch (err) {
      fail(err);
    }
  }

  function acceptSource(media: MediaInfo) {
    setSource(media);
    setAnalysis(null);
    setPoseData(null);
    setCameraMotionData(null);
    setMotionBlueprint(null);
    setExportResult(null);
    setError('');
    setProgress(0);
    setActiveStage(null);
    const end = Math.min(media.duration || 8, 8);
    setRange({ start: 0, end: Math.max(0.1, end) });
    setShotTitle(toShotTitle(media.name));
    setStage('idle');
    setMessage('请设置镜头范围，然后运行动作/摄影机分析。');
    restoredRef.current = true; // enable session autosave now that media exists
    window.motionPrevis?.saveSession(sessionFromMedia(media, { start: 0, end: Math.max(0.1, end) })).catch(() => undefined);
  }

  function reportStage(key: StageKey, fraction: number, text: string) {
    setActiveStage(key);
    setProgress(clamp(fraction, 0, 1));
    setMessage(text);
  }

  async function runAnalysis() {
    if (!source) return;
    if (source.filePath === DEMO_SOURCE_PATH) {
      loadDemo(true);
      pushToast('示例分析轨迹已刷新。');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setError('');
      setExportResult(null);
      setStage('preparing');
      reportStage('prepare', 0.04, '正在准备镜头范围和控制层');
      if (!window.motionPrevis) throw new Error('桌面桥接不可用，无法运行分析。');
      const prepared = await window.motionPrevis.prepareAnalysis({
        sourcePath: source.filePath,
        start: range.start,
        end: range.end,
        sampleFps,
        resolution
      });
      throwIfCancelled(controller.signal);
      setAnalysis(prepared);
      setStage('tracking');
      reportStage('pose', 0.18, '正在跟踪角色姿态');
      let pose: PoseData;
      try {
        pose = await analyzePoseVideo(
          prepared.referenceUrl,
          sampleFps,
          poseSettings,
          (nextProgress) => reportStage('pose', nextProgress, `正在跟踪角色姿态 ${Math.round(nextProgress * 100)}%`),
          controller.signal
        );
      } catch (poseError) {
        if (isCancelledError(poseError)) throw poseError;
        console.warn(poseError);
        pose = buildSyntheticPoseData(selectedDuration, sampleFps, prepared.frameSize.width, prepared.frameSize.height);
        pushToast('本地姿态模型暂不可用，已生成可编辑的动作预演轨迹。');
      }
      setPoseData(pose);
      if (useCameraMove) {
        reportStage('camera', 0.8, '正在求解摄影机运动');
        let cameraMove: CameraMotionData;
        try {
          cameraMove = await analyzeCameraMotionVideo(
            prepared.referenceUrl,
            Math.min(sampleFps, 12),
            pose,
            (nextProgress) => reportStage('camera', nextProgress, `正在求解摄影机运动 ${Math.round(nextProgress * 100)}%`),
            controller.signal
          );
        } catch (cameraError) {
          if (isCancelledError(cameraError)) throw cameraError;
          console.warn(cameraError);
          cameraMove = buildSyntheticCameraMotion(selectedDuration, Math.min(sampleFps, 12), prepared.frameSize.width, prepared.frameSize.height);
          pushToast('摄影机求解不可用，已生成预演用镜头运动曲线。');
        }
        setCameraMotionData(cameraMove);
      } else {
        setCameraMotionData(null);
      }
      throwIfCancelled(controller.signal);
      setCurrentTime(0);
      setStage('ready');
      setActiveStage(null);
      setProgress(0.82);
      setMessage(
        `分析完成：姿态 ${pose.summary.detectedFrames}/${pose.frames.length} 帧，补齐 ${pose.summary.filledFrames || 0} 个短缺口。`
      );
    } catch (err) {
      handleAnalysisError(controller.signal.aborted ? cancelledError() : err);
    } finally {
      abortRef.current = null;
    }
  }

  async function exportBundle(): Promise<ExportResult | null> {
    if (!analysis || !poseData) return null;
    if (!isFrameEncoderAvailable()) {
      return exportPlanningOnlyBundle();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const w = analysis.frameSize.width || 1280;
    const h = analysis.frameSize.height || 720;
    try {
      setStage('exporting');
      reportStage('encode', 0.82, '正在渲染高对比姿态视频');
      const poseVideo = await createPoseVideoBlob(
        poseData,
        w,
        h,
        (nextProgress) => reportStage('encode', nextProgress, `正在渲染姿态视频 ${Math.round(nextProgress * 100)}%`),
        controller.signal
      );
      const buffer = await poseVideo.arrayBuffer();

      // Phase-2 OpenPose/BODY_25 export (deterministic render + keypoints JSON).
      reportStage('encode', 0.9, '正在渲染 OpenPose BODY_25 骨架');
      const openPoseBlob = await renderOpenPoseFrames(
        poseData,
        w,
        h,
        (nextProgress) => reportStage('encode', nextProgress, `正在渲染 OpenPose 骨架 ${Math.round(nextProgress * 100)}%`),
        controller.signal
      );
      const openPoseVideoBuffer = await openPoseBlob.arrayBuffer();
      const openPoseKeypoints = buildOpenPoseJson(poseData, w, h);

      let aiDepthVideoBuffer: ArrayBuffer | undefined;
      if (useAiDepth) {
        try {
          reportStage('encode', 0.95, '正在渲染 AI 深度通道');
          const aiDepthVideo = await createAiDepthVideoBlob(
            analysis.referenceUrl,
            Math.min(sampleFps, 8),
            w,
            h,
            (nextProgress) => reportStage('encode', nextProgress, `正在渲染 AI 深度 ${Math.round(nextProgress * 100)}%`),
            controller.signal
          );
          aiDepthVideoBuffer = await aiDepthVideo.arrayBuffer();
        } catch (depthError) {
          if (isCancelledError(depthError)) throw depthError;
          console.warn(depthError);
          setMessage('AI 深度不可用，将导出快速深度替代说明。');
        }
      }

      throwIfCancelled(controller.signal);
      reportStage('bundle', 0.97, '正在保存动作预演包');
      if (!window.motionPrevis) throw new Error('桌面桥接不可用，无法保存导出包。');
      const saved = await window.motionPrevis.savePoseArtifacts({
        outputDir: analysis.outputDir,
        referencePath: analysis.referencePath,
        depthPath: analysis.depthPath,
        edgesPath: analysis.edgesPath,
        lineartPath: analysis.lineartPath,
        motionMaskPath: analysis.motionMaskPath,
        normalsPath: analysis.normalsPath,
        contactSheetPath: analysis.contactSheetPath,
        animaticPath: analysis.animaticPath,
        sourceName: analysis.sourceName,
        range: analysis.range,
        sampleFps,
        poseData,
        cameraMotionData: cameraMotionData || undefined,
        planningData,
        poseVideoBuffer: buffer,
        aiDepthVideoBuffer,
        openPoseVideoBuffer,
        openPoseKeypoints,
        resolution
      });
      setExportResult(saved);
      setProgress(1);
      setActiveStage(null);
      setStage('exported');
      setMessage('动作预演包已导出。');
      window.motionPrevis?.saveSession({ ...buildSession(), lastBundlePath: saved.outputDir }).catch(() => undefined);
      return saved;
    } catch (err) {
      const normalized = controller.signal.aborted ? cancelledError() : err;
      handleAnalysisError(normalized);
      throw normalized;
    } finally {
      abortRef.current = null;
    }
  }

  async function exportPlanningOnlyBundle(): Promise<ExportResult | null> {
    if (!analysis || !poseData) return null;
    try {
      setStage('exporting');
      setError('');
      reportStage('bundle', 0.92, '正在保存 JSON / Markdown 动作预演包');
      if (!window.motionPrevis?.savePlanningBundle) throw new Error('桌面桥接不可用，无法保存动作预演包。');
      const saved = await window.motionPrevis.savePlanningBundle({
        blueprint: motionBlueprint,
        planningData,
        poseData,
        cameraMotionData,
        analysis,
        localFirst: true
      });
      setExportResult(saved);
      setProgress(1);
      setActiveStage(null);
      setStage('exported');
      setMessage('动作预演包已导出：包含关键帧、镜头节奏、动作节点、姿态和摄影机 JSON。');
      await window.motionPrevis.saveSession({ ...buildSession(), lastBundlePath: saved.outputDir }).catch(() => undefined);
      pushToast('动作预演包已保存到本机。');
      return saved;
    } catch (err) {
      handleAnalysisError(err);
      throw err;
    } finally {
      abortRef.current = null;
    }
  }

  function cancelAnalysis() {
    abortRef.current?.abort();
    void window.motionPrevis?.cancelAnalysis().catch(() => undefined);
    setMessage('正在取消…');
  }

  function handleAnalysisError(err: unknown) {
    if (isCancelledError(err)) {
      setStage(analysis && poseData ? 'ready' : 'idle');
      setActiveStage(null);
      setProgress(analysis && poseData ? 0.82 : 0);
      setError('');
      setMessage('已取消。可以重新调整范围或再次分析。');
      pushToast('已取消本次分析。');
      return;
    }
    fail(err);
  }

  function fail(err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    setError(text);
    setMessage(text);
    setStage('error');
    setActiveStage(null);
    setProgress(0);
  }

  // Resolve the export-bundle video for a Send-to-Blockout kind. Returns null
  // when the requested layer wasn't produced in this bundle.
  function blockoutVideoPath(kind: SendToBlockoutWhich): string | null {
    if (!exportResult) return null;
    const files = exportResult.files;
    const pick = (value: string | null | undefined) => (typeof value === 'string' && value ? value : null);
    switch (kind) {
      case 'ai_depth':
        return pick(files.aiDepthMp4);
      case 'depth':
        return pick(files.aiDepthMp4) || pick(files.depth);
      case 'pose':
        return pick(files.poseMp4);
      case 'openpose':
        return pick(files.openPosePose);
      case 'reference':
      default:
        return pick(files.reference);
    }
  }

  async function sendToBlockout(kind: SendToBlockoutWhich) {
    if (!exportResult) return;
    const videoPath = blockoutVideoPath(kind);
    if (!videoPath) {
      pushToast(`当前没有可发送的 ${kind} 视频。`, 'error');
      return;
    }
    try {
      pushToast(`正在发送 ${kind} 到 Blockout…`);
      const result = await window.motionPrevis?.sendToBlockout({ videoPath, mode: 'ghost', opacity: 0.5 });
      if (result?.ok) pushToast(`已将 ${kind} 作为参考发送到 Blockout。`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  function updateStart(value: number) {
    const next = clamp(value, 0, Math.max(0, range.end - 0.1));
    setRange((current) => ({ ...current, start: next }));
  }

  function updateEnd(value: number) {
    const next = clamp(value, range.start + 0.1, Math.max(range.start + 0.1, duration));
    setRange((current) => ({ ...current, end: next }));
  }

  function updatePoseSetting<K extends keyof PoseAnalysisSettings>(key: K, value: PoseAnalysisSettings[K]) {
    setPoseSettings((current) => ({ ...current, [key]: value }));
  }

  function stepPoseSetting(key: 'temporalWindow' | 'maxPeople', delta: number) {
    setPoseSettings((current) => ({
      ...current,
      [key]: key === 'maxPeople' ? clamp(current[key] + delta, 1, 4) : clamp(current[key] + delta, 1, 30)
    }));
  }

  function toggleLayer(key: ControlLayerKey) {
    setSelectedLayers((current) => {
      if (current.includes(key)) {
        return current.length === 1 ? current : current.filter((item) => item !== key);
      }
      return [...current, key];
    });
  }

  function togglePreset(key: ExportPreset) {
    setExportPresets((current) => {
      if (current.includes(key)) {
        return current.length === 1 ? current : current.filter((item) => item !== key);
      }
      return [...current, key];
    });
  }

  function updateMotionKeyframe(id: string, patch: Partial<MotionKeyframe>) {
    setMotionBlueprint((current) => {
      if (!current) return current;
      return {
        ...current,
        keyframes: current.keyframes.map((keyframe) => (keyframe.id === id ? { ...keyframe, ...patch } : keyframe))
      };
    });
  }

  // Transport wiring — the reference <video> is the single source of playback.
  function withVideo(fn: (video: HTMLVideoElement) => void) {
    const video = referenceVideoRef.current;
    if (video) fn(video);
  }
  const playPause = () => withVideo((video) => (video.paused ? video.play() : video.pause()));
  const stepBack = () => withVideo((video) => (video.currentTime = Math.max(0, video.currentTime - 1 / Math.max(sampleFps, 1))));
  const stepForward = () =>
    withVideo((video) => (video.currentTime = Math.min(video.duration || video.currentTime + 1, video.currentTime + 1 / Math.max(sampleFps, 1))));
  const skipStart = () => withVideo((video) => (video.currentTime = 0));
  const skipEnd = () => withVideo((video) => (video.currentTime = video.duration || video.currentTime));

  const activeWorkflowStep = workflowStepForStage(stage);
  const previewUrl = analysis?.referenceUrl || source?.url || '';
  const previewPoster = analysis?.previewUrl;
  const sourceName = analysis?.sourceName || source?.name || '尚未载入素材';
  const durationLabel = source && source.duration ? formatTime(source.duration) : '--';
  const selectedDurationLabel = `${Math.round(selectedDuration)}s`;
  const frameRateLabel = source?.frameRate
    ? `${source.frameRate.toFixed(source.frameRate % 1 ? 2 : 0)} fps`
    : `${sampleFps} fps`;
  const resolutionLabel = source && source.width ? `${source.width} x ${source.height}` : '--';
  const qualityStatus = stage === 'exported' ? '已导出' : stage === 'ready' ? '可导出' : translateQuality(qualityReport.readiness);
  const poseModelName = POSE_MODEL_OPTIONS.find((option) => option.key === poseSettings.poseModel)?.label.replace('MediaPipe Pose ', '') || '姿态';
  const busy = isBusy(stage);
  const activeReferenceMode = REFERENCE_MODES.find((mode) => mode.key === subjectMode) || REFERENCE_MODES[0];

  // --- Agent-control surface (window.__mps) -------------------------------
  // Adopt an imported file/URL as the source through the exact same
  // acceptSource path a manual import takes. Not memoized: controlRef.actions
  // is rebuilt every render, so this always closes over current state.
  const controlImport = (media: MediaInfo) => {
    acceptSource(media);
    return { name: media.name, duration: media.duration, width: media.width, height: media.height };
  };

  const controlState: ControlState = {
    app: 'motion-previs-studio',
    version: versions.app || __MPS_APP_VERSION__,
    media: source
      ? { name: source.name, duration: source.duration, width: source.width, height: source.height }
      : null,
    range: { startS: range.start, endS: range.end },
    referenceMode: subjectMode,
    settings: {
      sampleFps,
      maxPeople: poseSettings.maxPeople,
      smoothing: poseSettings.smoothing,
      detectionConfidence: poseSettings.detectionConfidence,
      trackingConfidence: poseSettings.trackingConfidence,
      resolution,
      depthModel: poseSettings.depthModel,
      poseModel: poseSettings.poseModel,
      useCameraMove
    },
    analysis: {
      status: controlAnalysisStatus(stage),
      stage: activeStage ?? undefined,
      progress,
      poseFrames: poseData?.frames.length,
      detectedFrames: poseData?.summary.detectedFrames,
      cameraConfidence: cameraMotionData?.summary.averageConfidence,
      qualityScore: poseData ? qualityReport.score : undefined
    },
    lastBundlePath: exportResult?.outputDir ?? null,
    blockoutAvailable,
    conventions:
      'Times in seconds. Workflow: import_file/import_url → set_range/set_mode/set_settings → run_analysis → poll get_state until analysis.status is done → export_pack → send_to_blockout.'
  };

  controlRef.current = {
    state: controlState,
    actions: {
      importFile: async (path: string) => {
        if (!window.motionPrevis?.importPath) throw new Error('桌面桥接不可用。');
        const media = await window.motionPrevis.importPath(path);
        return controlImport(media);
      },
      importUrl: async (nextUrl: string) => {
        if (!window.motionPrevis?.importUrl) throw new Error('桌面桥接不可用。');
        setStage('importing');
        setMessage('正在载入网络视频链接');
        try {
          const media = await window.motionPrevis.importUrl(nextUrl);
          return controlImport(media);
        } catch (err) {
          fail(err);
          throw err;
        }
      },
      setRange: (startS: number, endS: number) => {
        setRange({ start: startS, end: endS });
        return { startS, endS };
      },
      setMode: (mode) => {
        setSubjectMode(mode);
        return { referenceMode: mode };
      },
      setSettings: (patch: ControlSettingsPatch) => {
        if (patch.sampleFps !== undefined) setSampleFps(clamp(patch.sampleFps, 4, 24));
        if (patch.resolution !== undefined) setResolution(patch.resolution);
        setPoseSettings((current) => ({
          ...current,
          maxPeople: patch.maxPeople !== undefined ? clamp(patch.maxPeople, 1, 4) : current.maxPeople,
          smoothing: patch.smoothing !== undefined ? clamp(patch.smoothing, 0, 0.95) : current.smoothing,
          detectionConfidence:
            patch.detectionConfidence !== undefined ? clamp(patch.detectionConfidence, 0.1, 0.9) : current.detectionConfidence,
          trackingConfidence:
            patch.trackingConfidence !== undefined ? clamp(patch.trackingConfidence, 0.1, 0.9) : current.trackingConfidence
        }));
        // Return the applied values (state setters are async; the current
        // snapshot in controlRef.state still holds pre-update values).
        const prev = controlRef.current!.state.settings;
        return {
          ...prev,
          sampleFps: patch.sampleFps !== undefined ? clamp(patch.sampleFps, 4, 24) : prev.sampleFps,
          resolution: patch.resolution !== undefined ? patch.resolution : prev.resolution,
          maxPeople: patch.maxPeople !== undefined ? clamp(patch.maxPeople, 1, 4) : prev.maxPeople,
          smoothing: patch.smoothing !== undefined ? clamp(patch.smoothing, 0, 0.95) : prev.smoothing,
          detectionConfidence:
            patch.detectionConfidence !== undefined ? clamp(patch.detectionConfidence, 0.1, 0.9) : prev.detectionConfidence,
          trackingConfidence:
            patch.trackingConfidence !== undefined ? clamp(patch.trackingConfidence, 0.1, 0.9) : prev.trackingConfidence
        };
      },
      runAnalysis: () => {
        if (!source) throw new Error('尚未载入素材，请先导入文件或加载示例。');
        if (isBusy(stage)) throw new Error('当前正在分析或导出，请等待完成。');
        void runAnalysis();
        return { started: true as const };
      },
      exportPack: async () => {
        if (!analysis || !poseData) {
          throw new Error('尚无完成的分析，请先运行分析并等待状态完成。');
        }
        if (isBusy(stage)) throw new Error('当前正在处理，请等待完成。');
        const saved = await exportBundle();
        if (!saved) throw new Error('导出没有生成动作预演包。');
        return { bundlePath: saved.outputDir, zipPath: saved.zipPath };
      },
      listBundle: async () => {
        const bundlePath = exportResult?.outputDir;
        if (!bundlePath) throw new Error('尚无导出包，请先执行 export_pack。');
        const files = Object.values(exportResult!.files).filter((value): value is string => typeof value === 'string');
        return { bundlePath, files };
      },
      sendToBlockout: async (which: SendToBlockoutWhich) => {
        if (!exportResult) throw new Error('尚无导出包，请先执行 export_pack。');
        const videoPath = blockoutVideoPath(which);
        if (!videoPath) throw new Error(`当前导出包没有 ${which} 视频。`);
        if (!window.motionPrevis?.sendToBlockout) throw new Error('桌面桥接不可用。');
        const result = await window.motionPrevis.sendToBlockout({ videoPath, mode: 'ghost', opacity: 0.5 });
        if (!result?.ok) throw new Error('Blockout 未接收参考视频。');
        return { ok: true as const, which, videoPath, handoffVersion: result.handoffVersion };
      }
    }
  };

  useEffect(() => {
    const api: MpsControlSurface = {
      getState: () => controlRef.current!.state,
      importFile: (path) => controlRef.current!.actions.importFile(path),
      importUrl: (nextUrl) => controlRef.current!.actions.importUrl(nextUrl),
      setRange: (startS, endS) => controlRef.current!.actions.setRange(startS, endS),
      setMode: (mode) => controlRef.current!.actions.setMode(mode),
      setSettings: (patch) => controlRef.current!.actions.setSettings(patch),
      runAnalysis: () => controlRef.current!.actions.runAnalysis(),
      exportPack: () => controlRef.current!.actions.exportPack(),
      listBundle: () => controlRef.current!.actions.listBundle(),
      sendToBlockout: (which) => controlRef.current!.actions.sendToBlockout(which)
    };
    window.__mps = api;
    return () => {
      if (window.__mps === api) delete window.__mps;
    };
  }, []);

  return (
    <main className={`app-shell platform-${appInfo?.platform === 'darwin' ? 'macos' : appInfo?.platform === 'win32' ? 'windows' : 'linux'}`}>
      <header className="top-chrome">
        <div className="brand-mark" aria-hidden="true">
          <img src={logoUrl} alt="" className="brand-logo-sm" />
        </div>
        <div className="top-title">
          <h1>{appDisplayName}</h1>
          <p>中文动作预演 · 镜头运动设计 · 动态分镜规划</p>
          <div className="brand-links" aria-label="BloomReel 项目链接">
            <ExternalLinkButton url="https://github.com/MookeeHugo">BloomReel 项目入口</ExternalLinkButton>
          </div>
        </div>
        <WorkflowStepper activeStep={activeWorkflowStep} />
        <div className="top-actions" aria-label="应用工具">
          <IconButton label="打开素材" onClick={loadFile} disabled={busy}>
            <FolderOpen size={18} />
          </IconButton>
          <IconButton label="保存项目" onClick={saveProject} disabled={!source}>
            <Save size={18} />
          </IconButton>
          <IconButton label="设置">
            <Settings2 size={18} />
          </IconButton>
          <IconButton label="帮助" onClick={() => setShowHelp(true)}>
            <HelpCircle size={18} />
          </IconButton>
        </div>
      </header>

      <div className="studio-shell">
      <aside className="sidebar left-sidebar">
        <section className="panel source-panel">
          <div className="panel-title">
            <FileVideo size={16} />
            <span>素材来源</span>
          </div>
          <div className="import-grid">
            <button className="secondary-action" onClick={loadFile} disabled={busy}>
              <Upload size={16} />
              导入素材
            </button>
            <button className="secondary-action" onClick={loadUrl} disabled={!url.trim() || busy}>
              <Youtube size={16} />
              网络视频
            </button>
            <button className="secondary-action demo-action" onClick={() => loadDemo()} disabled={busy}>
              <Clapperboard size={16} />
              加载雨夜灯塔示例
            </button>
          </div>
          <div className="url-row">
            <Link size={15} />
            <input
              value={url}
              placeholder="粘贴 YouTube 或直链视频"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && url.trim()) loadUrl();
              }}
            />
          </div>
          {source ? (
            <div className="source-card">
              <ShotThumb previewUrl={previewUrl} poster={previewPoster} />
              <div>
                <strong>{source.name}</strong>
                <span>
                  {source.width ? `${source.width}x${source.height} · ` : ''}
                  {frameRateLabel}
                  {source.videoCodec && source.videoCodec !== 'unknown' ? ` · ${source.videoCodec}` : ''}
                </span>
              </div>
              <CheckCircle2 size={16} />
            </div>
          ) : (
            <div className="empty-note">支持 MP4、MOV、MKV、WebM、本地优先导入和兼容的视频链接；也可一键加载中文动作预演 demo。</div>
          )}
        </section>

        <section className="panel project-panel">
          <div className="panel-title">
            <SquareStack size={16} />
            <span>镜头计划</span>
          </div>
          <label className="control-label">
            项目
            <input className="text-field" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} disabled={busy} />
          </label>
          <div className="split-fields">
            <label className="control-label">
              场次
              <input className="text-field" value={sceneTitle} onChange={(event) => setSceneTitle(event.target.value)} disabled={busy} />
            </label>
            <label className="control-label">
              镜头
              <input className="text-field" value={shotTitle} onChange={(event) => setShotTitle(event.target.value)} disabled={busy} />
            </label>
          </div>
          <label className="control-label">
            导演意图
            <textarea className="textarea-field" value={creativeIntent} onChange={(event) => setCreativeIntent(event.target.value)} disabled={busy} rows={2} />
          </label>
        </section>

        <section className="panel project-panel">
          <div className="panel-title">
            <Info size={16} />
            <span>项目信息</span>
          </div>
          <InfoRow label="画幅" value={resolutionLabel} />
          <InfoRow label="帧率" value={frameRateLabel} />
          <InfoRow label="素材时长" value={durationLabel} />
          <InfoRow label="分析日期" value={formatDisplayDate(analysis?.createdAt)} />
        </section>

        <section className="panel range-panel">
          <div className="panel-title">
            <Scissors size={16} />
            <span>镜头范围</span>
          </div>
          <div className="range-readout">
            <strong>{formatTime(range.start)}</strong>
            <span>{formatTime(selectedDuration)}</span>
            <strong>{formatTime(range.end)}</strong>
          </div>
          <label className="control-label">
            起点
            <input
              type="range"
              min={0}
              max={Math.max(0.1, duration)}
              step={0.05}
              value={range.start}
              onChange={(event) => updateStart(Number(event.target.value))}
              disabled={!source || busy}
            />
          </label>
          <label className="control-label">
            终点
            <input
              type="range"
              min={0}
              max={Math.max(0.1, duration)}
              step={0.05}
              value={range.end}
              onChange={(event) => updateEnd(Number(event.target.value))}
              disabled={!source || busy}
            />
          </label>
          <div className="time-inputs">
            <input value={range.start.toFixed(2)} onChange={(event) => updateStart(Number(event.target.value))} />
            <input value={range.end.toFixed(2)} onChange={(event) => updateEnd(Number(event.target.value))} />
          </div>
        </section>

        <section className="panel status-panel">
          <div className="panel-title">
            <Activity size={16} />
            <span>分析与生成</span>
          </div>
          {busy ? (
            <button className="primary-action cancel-action" onClick={cancelAnalysis}>
              <Square size={15} />
              取消
            </button>
          ) : (
            <button className="primary-action" onClick={runAnalysis} disabled={!source}>
              <Play size={17} />
              运行动作分析
            </button>
          )}
          <StageRail steps={STAGE_STEPS} activeStage={activeStage} stage={stage} />
          <div className="progress-track">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className={error ? 'status-text error' : 'status-text'}>{message}</p>
        </section>
      </aside>

      <section className="workspace">
        {!source ? (
          <WelcomeState appTitle={appDisplayName} onImport={loadFile} onDemo={() => loadDemo()} onHelp={() => setShowHelp(true)} />
        ) : (
          <>
            <div className="workspace-toolbar">
              <div className="shot-context">
                <strong>{shotTitle || '镜头 01A'}</strong>
                <span>{sourceName}</span>
              </div>
              <div className="timecode">
                {formatTime(currentTime)} / {formatTime(selectedDuration)}
              </div>
              <div className="view-tools">
                <button type="button">适配</button>
                <IconButton label="画面适配">
                  <Maximize2 size={16} />
                </IconButton>
              </div>
            </div>

            <div className="preview-grid">
              <PreviewPane title="参考画面" tone="reference-main">
                {analysis ? (
                  <MediaVisual
                    ref={referenceVideoRef}
                    url={analysis.referenceUrl}
                    poster={analysis.previewUrl}
                    controls
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                    onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
                  />
                ) : (
                  <MediaVisual
                    ref={referenceVideoRef}
                    url={source.url}
                    controls
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                  />
                )}
              </PreviewPane>

              <PreviewPane title="摄影机路径" tone="camera-main">
                <CameraPathPreview videoUrl={previewUrl} poster={previewPoster} cameraMotionData={cameraMotionData} />
              </PreviewPane>

              <PreviewPane title="角色姿态 / 2D 骨架" tone="pose-actor">
                <PoseOverlayPreview
                  frame={currentPoseFrame}
                  videoUrl={previewUrl}
                  poster={previewPoster}
                  width={analysis?.frameSize.width || source?.width || 1280}
                  height={analysis?.frameSize.height || source?.height || 720}
                />
              </PreviewPane>

              <PreviewPane title="深度层" tone="depth-mini">
                <LayerVideo url={analysis?.depthUrl} poster={analysis?.previewUrl} label="分析后显示深度层" />
              </PreviewPane>

              <PreviewPane title="边缘/线稿" tone="edges-mini">
                <LayerVideo url={analysis?.edgesUrl || analysis?.lineartUrl} label="分析后显示边缘线稿" />
              </PreviewPane>

              <PreviewPane title="动作遮罩" tone="masks-mini">
                <LayerVideo url={analysis?.motionMaskUrl} label="分析后显示动作遮罩" />
              </PreviewPane>

              <PreviewPane title="3D 动作骨架" tone="pose-all">
                <PoseAllPreview frame={currentPoseFrame} poseData={poseData} />
              </PreviewPane>
            </div>

            <TransportBar
              sampleFps={sampleFps}
              isPlaying={isPlaying}
              onPlayPause={playPause}
              onStepBack={stepBack}
              onStepForward={stepForward}
              onSkipStart={skipStart}
              onSkipEnd={skipEnd}
              disabled={!analysis && !source}
            />

            <div className="timeline">
              <div className="timeline-head">
                <span>{shotTitle || '镜头 01A'}</span>
                <strong>{selectedDurationLabel}</strong>
              </div>
              <div className="timeline-track">
                <TimelineFilmstrip previewUrl={previewUrl} poster={previewPoster} />
                <div
                  className="timeline-selection"
                  style={{
                    left: `${duration ? (range.start / duration) * 100 : 0}%`,
                    width: `${duration ? ((range.end - range.start) / duration) * 100 : 0}%`
                  }}
                />
                <div className="timeline-playhead" style={{ left: `${selectedDuration ? (currentTime / selectedDuration) * 100 : 50}%` }} />
                {poseData?.frames.map((frame, index) => (
                  <span
                    key={`${frame.time}-${index}`}
                    className={frame.filled ? 'pose-tick filled' : frame.landmarks.length ? 'pose-tick detected' : 'pose-tick'}
                    style={{ left: `${(index / Math.max(poseData.frames.length - 1, 1)) * 100}%` }}
                  />
                ))}
              </div>
            </div>

            <div className="analysis-dock">
              <StatusItem icon={<CheckCircle2 size={18} />} label="分析状态" value={STAGE_LABELS[stage]} />
              <StatusItem icon={<BrainGlyph />} label="模型" value={`${poseModelName} + ${useAiDepth ? 'AI 深度' : '快速深度'}`} />
              <StatusItem icon={<Cpu size={18} />} label="运行环境" value={poseData?.summary.runtimeDelegate ? `${poseData.summary.runtimeDelegate}` : useAiDepth ? 'WebGPU/CPU' : 'CPU'} />
              <StatusItem icon={<Monitor size={18} />} label="画幅" value={resolutionLabel} />
              <StatusItem icon={<Clapperboard size={18} />} label="FPS" value={frameRateLabel} />
            </div>
          </>
        )}
      </section>

      <aside className="sidebar right-sidebar">
        {motionBlueprint ? (
          <MotionPlanPanel blueprint={motionBlueprint} busy={busy} onUpdateKeyframe={updateMotionKeyframe} />
        ) : null}

        <section className="panel reference-mode-panel">
          <div className="panel-heading">
            <h2>参考模式</h2>
            <span className="status-pill green">{activeReferenceMode.label}</span>
          </div>
          <div className="reference-mode-segment" role="radiogroup" aria-label="参考模式">
            {REFERENCE_MODES.map((mode) => (
              <button
                key={mode.key}
                type="button"
                role="radio"
                aria-checked={subjectMode === mode.key}
                className={subjectMode === mode.key ? 'reference-mode-option active' : 'reference-mode-option'}
                onClick={() => setSubjectMode(mode.key)}
                disabled={busy}
              >
                <strong>{mode.label}</strong>
                <em>{mode.hint}</em>
              </button>
            ))}
          </div>
          <label className="control-label">
            视觉风格
            <textarea className="textarea-field compact" value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} disabled={busy} rows={2} />
          </label>
        </section>

        <section className="panel analyze-panel">
          <div className="panel-title">
            <Settings2 size={16} />
            <span>分析参数</span>
          </div>
          <SettingSelect
            label="姿态模型"
            value={poseSettings.poseModel}
            options={POSE_MODEL_OPTIONS.map((option) => ({ value: option.key, label: option.label, title: option.detail }))}
            onChange={(value) => updatePoseSetting('poseModel', value as PoseModelKey)}
            disabled={busy}
          />
          <SettingSelect
            label="深度模型"
            value={poseSettings.depthModel}
            options={DEPTH_MODEL_OPTIONS.map((option) => ({ value: option.key, label: option.label, title: option.detail }))}
            onChange={(value) => updatePoseSetting('depthModel', value as PoseAnalysisSettings['depthModel'])}
            disabled={busy}
          />
          <SettingSlider
            label="检测置信度"
            value={poseSettings.detectionConfidence}
            min={0.1}
            max={0.9}
            step={0.05}
            onChange={(value) => updatePoseSetting('detectionConfidence', value)}
            format={(value) => value.toFixed(2)}
            disabled={busy}
          />
          <SettingSlider
            label="跟踪置信度"
            value={poseSettings.trackingConfidence}
            min={0.1}
            max={0.9}
            step={0.05}
            onChange={(value) => updatePoseSetting('trackingConfidence', value)}
            format={(value) => value.toFixed(2)}
            disabled={busy}
          />
          <SettingSlider
            label="动作平滑"
            value={poseSettings.smoothing}
            min={0}
            max={0.95}
            step={0.05}
            onChange={(value) => updatePoseSetting('smoothing', value)}
            format={(value) => `${Math.round(value * 100)}%`}
            disabled={busy}
          />
          <StepperRow label="补帧窗口" value={poseSettings.temporalWindow} suffix="帧" onMinus={() => stepPoseSetting('temporalWindow', -1)} onPlus={() => stepPoseSetting('temporalWindow', 1)} disabled={busy} />
          <StepperRow label="最大人数" value={poseSettings.maxPeople} onMinus={() => stepPoseSetting('maxPeople', -1)} onPlus={() => stepPoseSetting('maxPeople', 1)} disabled={busy} />
          <label className="toggle-row">
            <input type="checkbox" checked={poseSettings.fillGaps} onChange={(event) => updatePoseSetting('fillGaps', event.target.checked)} disabled={busy} />
            自动补齐短缺口
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={useCameraMove} onChange={(event) => setUseCameraMove(event.target.checked)} disabled={busy} />
            求解摄影机运动
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={poseSettings.optimizeForExport} onChange={(event) => updatePoseSetting('optimizeForExport', event.target.checked)} disabled={busy} />
            面向导出优化
          </label>
          <SettingSlider label="采样 FPS" value={sampleFps} min={4} max={24} step={1} onChange={setSampleFps} format={(value) => `${value} fps`} disabled={busy} />
          <SettingSelect
            label="导出画幅"
            value={resolution}
            options={[
              { value: 'auto', label: '自动（长边保留）', title: '沿用源素材长边比例。' },
              { value: '720p', label: '720p（短边）', title: '控制层短边缩放到 720，适合常见视频生成流程。' }
            ]}
            onChange={(value) => setResolution(value as ExportResolution)}
            disabled={busy}
          />
        </section>

        <section className="panel">
          <div className="panel-title">
            <Layers3 size={16} />
            <span>控制层</span>
          </div>
          <div className="chip-grid">
            {CONTROL_LAYERS.map((layer) => (
              <label key={layer.key} className={selectedLayers.includes(layer.key) ? 'chip-toggle selected' : 'chip-toggle'}>
                <input type="checkbox" checked={selectedLayers.includes(layer.key)} onChange={() => toggleLayer(layer.key)} disabled={busy} />
                {layer.label}
              </label>
            ))}
          </div>
          <div className="setting-row">
            <span>已选择</span>
            <strong>{analysis ? `${selectedLayers.length} 层` : '--'}</strong>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Box size={16} />
            <span>姿态诊断</span>
          </div>
          <div className="metric-grid">
            <Metric label="帧数" value={poseData ? String(poseData.summary.totalFrames || poseData.frames.length) : '--'} />
            <Metric label="跟踪" value={poseData ? `${poseData.summary.rawDetectedFrames ?? poseData.summary.detectedFrames}/${poseData.summary.totalFrames || poseData.frames.length}` : '--'} />
            <Metric label="置信度" value={poseData ? `${Math.round(poseData.summary.averageScore * 100)}%` : '--'} />
            <Metric label="补帧" value={poseData ? String(poseData.summary.filledFrames || 0) : '--'} />
            <Metric label="人数" value={poseData ? String(poseData.summary.maxPeopleDetected || 0) : '--'} />
            <Metric label="动势" value={poseData ? poseData.summary.motionEnergy.toFixed(3) : '--'} />
          </div>
          <div className="diagnostic-list">
            {(poseData?.summary.diagnostics || ['运行动作分析后显示跟踪诊断。']).slice(0, 3).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Camera size={16} />
            <span>摄影机运动</span>
          </div>
          <div className="metric-grid">
            <Metric label="横摇" value={cameraMotionData ? `${cameraMotionData.summary.panPixels.toFixed(0)}px` : '--'} />
            <Metric label="俯仰" value={cameraMotionData ? `${cameraMotionData.summary.tiltPixels.toFixed(0)}px` : '--'} />
            <Metric label="推拉" value={cameraMotionData ? `${cameraMotionData.summary.zoomRatio.toFixed(2)}x` : '--'} />
            <Metric label="求解" value={cameraMotionData ? `${Math.round(cameraMotionData.summary.averageConfidence * 100)}%` : '--'} />
          </div>
        </section>

        <section className="panel quality-panel">
          <div className="panel-title">
            <Gauge size={16} />
            <span>交付质量</span>
          </div>
          <div className="quality-layout">
            <div className="quality-ring" style={{ background: `conic-gradient(var(--green) ${qualityReport.score * 3.6}deg, #1a2224 0deg)` }}>
              <strong>{qualityReport.score}</strong>
            </div>
            <div className="quality-list">
              <InfoRow label="姿态跟踪" value={translateQuality(qualityReport.tracking)} />
              <InfoRow label="镜头稳定" value={translateQuality(qualityReport.camera)} />
              <InfoRow label="控制层完整" value={translateQuality(qualityReport.layers)} />
              <InfoRow label="总体" value={qualityStatus} />
            </div>
          </div>
        </section>

        <section className="panel exports-panel">
          <div className="panel-title">
            <Download size={16} />
            <span>导出预设</span>
          </div>
          <div className="preset-grid">
            {EXPORT_PRESETS.map((preset) => (
              <PresetTile key={preset.key} preset={preset.key} label={preset.label} selected={exportPresets.includes(preset.key)} onToggle={() => togglePreset(preset.key)} disabled={busy} />
            ))}
          </div>
          <button className="primary-action export-button" onClick={exportBundle} disabled={!poseData || !analysis || busy}>
            <FileArchive size={17} />
            导出动作预演包
          </button>
          {exportResult ? (
            <div className="export-result">
              <strong>动作预演包已生成</strong>
              <div className="export-result-actions">
                <button className="secondary-action" onClick={() => window.motionPrevis?.openPath(exportResult.outputDir)}>
                  <FolderOpen size={15} />
                  打开文件夹
                </button>
                <button className="secondary-action" onClick={() => window.motionPrevis?.revealPath(exportResult.zipPath)}>
                  定位导出清单
                </button>
              </div>
              <div className="blockout-send">
                <span className="blockout-send-label">
                  <Send size={13} /> 发送到 Blockout
                  <em className={blockoutAvailable ? 'blockout-dot on' : 'blockout-dot'} title={blockoutAvailable ? 'Blockout 已运行' : '未检测到 Blockout'} />
                </span>
                <div className="export-result-actions">
                  <button className="secondary-action" onClick={() => sendToBlockout('reference')} disabled={!blockoutAvailable}>
                    参考
                  </button>
                  <button className="secondary-action" onClick={() => sendToBlockout('depth')} disabled={!blockoutAvailable}>
                    深度
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-note">导出包含关键帧、镜头节奏、动作节点、姿态/摄影机 JSON、提示词、镜头表和本机说明文件；无需账号或 API 密钥。</div>
          )}
        </section>

        <section className="panel system-panel">
          <div className="panel-title">
            <Info size={16} />
            <span>本机与授权</span>
          </div>
          <strong>{CREDIT_LINE}</strong>
          {appInfo?.isCommunityBuild && appInfo.maintainer ? (
            <span className="community-maintainer">社区构建 · Windows 版维护：{appInfo.maintainer}</span>
          ) : null}
          <span className="system-links">
            <ExternalLinkButton url="https://github.com/MookeeHugo">BloomReel 项目入口</ExternalLinkButton>
          </span>
          <span>运行时：{versions.electron || '--'}</span>
          <span>本地优先 · 无需账号/API 密钥 · 创作资料不上云</span>
          <span>本机输出：{versions.workspace || '--'}</span>
        </section>
      </aside>
      </div>

      {restorePrompt ? (
        <div className="restore-banner" role="dialog" aria-label={restorePrompt.kind === 'relink' ? '重新关联缺失素材' : '恢复上次项目'}>
          <RotateCcw size={16} />
          <span>
            {restorePrompt.kind === 'relink'
              ? `上次项目素材缺失：请重新定位 ${restorePrompt.session.sourceName || '之前的素材'}。`
              : `是否恢复上次项目：${restorePrompt.session.sourceName || '之前的素材'}？`}
          </span>
          <div>
            <button className="secondary-action" onClick={restorePrompt.kind === 'relink' ? relinkLastSession : restoreLastSession}>
              {restorePrompt.kind === 'relink' ? '重新关联' : '恢复项目'}
            </button>
            <button className="secondary-action ghost" onClick={() => setRestorePrompt(null)}>暂不处理</button>
          </div>
        </div>
      ) : null}

      {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={toast.tone === 'error' ? 'toast error' : 'toast'}>
            {toast.text}
          </div>
        ))}
      </div>
    </main>
  );
}

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) {
    const error = new Error('Analysis cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function cancelledError() {
  const error = new Error('Analysis cancelled.');
  error.name = 'AbortError';
  return error;
}

function WelcomeState({
  appTitle,
  onImport,
  onDemo,
  onHelp
}: {
  appTitle: string;
  onImport: () => void;
  onDemo: () => void;
  onHelp: () => void;
}) {
  return (
    <div className="welcome-state">
      <img src={logoUrl} alt="Motion Previs Studio" className="welcome-logo" />
      <h2>{appTitle}</h2>
      <p>面向中文影视创作者的动作预演、镜头运动设计与动态分镜规划工具。本地优先，无需账号或 API 密钥，创作资料不上云。</p>
      <div className="welcome-actions">
        <button className="primary-action" onClick={onDemo}>
          <Clapperboard size={17} />
          加载雨夜灯塔示例
        </button>
        <button className="primary-action" onClick={onImport}>
          <Upload size={17} />
          导入视频素材
        </button>
        <button className="secondary-action" onClick={onHelp}>
          <HelpCircle size={16} />
          查看帮助
        </button>
      </div>
      <p className="welcome-credit">{CREDIT_LINE}</p>
    </div>
  );
}

const HELP_CARDS: { step: string; title: string; body: string }[] = [
  { step: '1', title: '导入', body: '打开本地视频，或粘贴兼容的视频链接；也可以直接加载雨夜灯塔示例。' },
  { step: '2', title: '定范围', body: '用起点/终点滑杆截出一个动作段落，确保镜头节奏明确。' },
  { step: '3', title: '选模式', body: '按需要保留摄影机、角色动作、载具/道具路径或完整场景。' },
  { step: '4', title: '跑分析', body: '求解姿态、角色位移和摄影机运动；中途可取消。' },
  { step: '5', title: '调关键帧', body: '复核镜头编号、动作节拍、速度/时长、转场和风险备注。' },
  { step: '6', title: '导出', body: '导出本机动作预演包，供分镜、片场调度、AI 视频或 Blockout 继续使用。' }
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="help-overlay" role="dialog" aria-label="快速帮助" onClick={onClose}>
      <div className="help-panel" onClick={(event) => event.stopPropagation()}>
        <div className="help-header">
          <div className="help-title">
            <img src={logoUrl} alt="" className="brand-logo-sm" />
            <h2>快速开始</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭帮助" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="help-cards">
          {HELP_CARDS.map((card) => (
            <div key={card.step} className="help-card">
              <span className="help-step">{card.step}</span>
              <strong>{card.title}</strong>
              <p>{card.body}</p>
            </div>
          ))}
        </div>
        <p className="help-credit">{CREDIT_LINE}</p>
      </div>
    </div>
  );
}

function MotionPlanPanel({
  blueprint,
  busy,
  onUpdateKeyframe
}: {
  blueprint: MotionPlanBlueprint;
  busy: boolean;
  onUpdateKeyframe: (id: string, patch: Partial<MotionKeyframe>) => void;
}) {
  return (
    <section className="panel motion-plan-panel">
      <div className="panel-heading">
        <h2>动作段落与关键帧</h2>
        <span className="status-pill green">{blueprint.keyframes.length} 个关键帧</span>
      </div>
      <strong className="motion-project-title">{blueprint.projectTitle}</strong>
      <p className="motion-logline">{blueprint.logline}</p>
      <div className="motion-summary-grid">
        <Metric label="镜头段落" value={String(blueprint.shots.length)} />
        <Metric label="动作节点" value={String(blueprint.actionNodes.length)} />
        <Metric label="角色/载具" value={String(blueprint.subjects.length)} />
        <Metric label="总时长" value={`${blueprint.duration.toFixed(1)}s`} />
      </div>
      <div className="shot-beat-grid">
        {blueprint.shots.map((shot) => (
          <article key={shot.id} className="shot-beat-card">
            <strong>{shot.id} · {shot.title}</strong>
            <span>{shot.duration.toFixed(1)}s · {shot.camera}</span>
            <p>{shot.action}</p>
            <em>{shot.emotion}</em>
          </article>
        ))}
      </div>
      <div className="action-node-rail" aria-label="动作节点">
        {blueprint.actionNodes.map((node) => (
          <span key={node.id} className="action-node-pill" title={node.note}>
            {node.time.toFixed(1)}s · {node.label}
          </span>
        ))}
      </div>
      <div className="subject-grid">
        {blueprint.subjects.map((subject) => (
          <article key={subject.id} className="subject-card">
            <strong>{subject.name}</strong>
            <span>{subject.role}</span>
            <p>{subject.path}</p>
            <em>{subject.speed}</em>
          </article>
        ))}
      </div>
      <div className="keyframe-list">
        {blueprint.keyframes.map((keyframe) => (
          <article key={keyframe.id} className="keyframe-row">
            <div className="keyframe-meta">
              <strong>{keyframe.shot}</strong>
              <span>{keyframe.time.toFixed(1)}s / {keyframe.duration.toFixed(1)}s</span>
            </div>
            <label>
              <span>动作节拍</span>
              <input value={keyframe.beat} onChange={(event) => onUpdateKeyframe(keyframe.id, { beat: event.target.value })} disabled={busy} />
            </label>
            <label>
              <span>角色位移</span>
              <textarea value={keyframe.actorMove} onChange={(event) => onUpdateKeyframe(keyframe.id, { actorMove: event.target.value })} disabled={busy} rows={2} />
            </label>
            <label>
              <span>摄影机运动</span>
              <textarea value={keyframe.cameraMove} onChange={(event) => onUpdateKeyframe(keyframe.id, { cameraMove: event.target.value })} disabled={busy} rows={2} />
            </label>
            <label>
              <span>速度/时长</span>
              <input value={keyframe.speed} onChange={(event) => onUpdateKeyframe(keyframe.id, { speed: event.target.value })} disabled={busy} />
            </label>
            <label>
              <span>风险备注</span>
              <textarea value={keyframe.risk} onChange={(event) => onUpdateKeyframe(keyframe.id, { risk: event.target.value })} disabled={busy} rows={2} />
            </label>
          </article>
        ))}
      </div>
      <div className="risk-note-list">
        {blueprint.riskNotes.map((note) => <span key={note}>{note}</span>)}
      </div>
    </section>
  );
}
function StageRail({ steps, activeStage, stage }: { steps: { key: StageKey; label: string }[]; activeStage: StageKey | null; stage: Stage }) {
  const doneMap: Record<StageKey, boolean> = {
    prepare: stage === 'ready' || stage === 'exported' || stage === 'exporting' || (activeStage !== null && activeStage !== 'prepare'),
    pose: stage === 'ready' || stage === 'exported' || stage === 'exporting' || activeStage === 'camera' || activeStage === 'encode' || activeStage === 'bundle',
    camera: stage === 'exported' || stage === 'exporting' || activeStage === 'encode' || activeStage === 'bundle',
    encode: stage === 'exported' || activeStage === 'bundle',
    bundle: stage === 'exported'
  };
  return (
    <div className="stage-rail" aria-label="分析阶段">
      {steps.map((step) => {
        const active = activeStage === step.key;
        const done = doneMap[step.key];
        return (
          <div key={step.key} className={`stage-chip${active ? ' active' : ''}${done ? ' done' : ''}`}>
            <span className="stage-dot" />
            {step.label}
          </div>
        );
      })}
    </div>
  );
}

function WorkflowStepper({ activeStep }: { activeStep: number }) {
  return (
    <nav className="workflow-stepper" aria-label="工作流">
      {WORKFLOW_STEPS.map((step, index) => (
        <div key={step} className={index <= activeStep ? 'workflow-step active' : 'workflow-step'}>
          <span>{index + 1}</span>
          <strong>{step}</strong>
        </div>
      ))}
    </nav>
  );
}

function IconButton({ label, children, disabled, onClick }: { label: string; children: ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button className="icon-button" type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function ShotThumb({ previewUrl, poster }: { previewUrl?: string; poster?: string }) {
  if (poster) {
    return (
      <span className="shot-thumb">
        <img src={poster} alt="" />
      </span>
    );
  }
  if (previewUrl) {
    if (isImageUrl(previewUrl)) {
      return (
        <span className="shot-thumb">
          <img src={previewUrl} alt="" />
        </span>
      );
    }
    return (
      <span className="shot-thumb">
        <video src={previewUrl} muted playsInline preload="metadata" />
      </span>
    );
  }
  return (
    <span className="shot-thumb empty">
      <FilmIcon />
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PreviewPane({ title, tone, children }: { title: string; tone: string; children: ReactNode }) {
  return (
    <article className={`preview-pane ${tone}`}>
      <header>{title}</header>
      <div className="preview-content">{children}</div>
    </article>
  );
}

function EmptyPreview({ icon, label }: { icon?: ReactNode; label: string }) {
  return (
    <div className="empty-preview">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function LayerVideo({ url, poster, label }: { url?: string; poster?: string; label: string }) {
  return url ? <MediaVisual url={url} poster={poster} muted loop controls playsInline /> : <EmptyPreview label={label} />;
}

type MediaVisualProps = {
  url?: string;
  poster?: string;
  controls?: boolean;
  muted?: boolean;
  loop?: boolean;
  playsInline?: boolean;
  onPlay?: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
  onPause?: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
  onTimeUpdate?: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
  onSeeked?: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
};

const MediaVisual = forwardRef<HTMLVideoElement, MediaVisualProps>(function MediaVisual(
  { url, poster, controls, muted = true, loop, playsInline = true, onPlay, onPause, onTimeUpdate, onSeeked },
  ref
) {
  const visualUrl = url || poster;
  if (!visualUrl) return <EmptyPreview label="暂无可预览画面" />;
  if (isImageUrl(visualUrl)) {
    return <img className="media-visual-image" src={visualUrl} alt="动作预演参考画面" />;
  }
  return (
    <video
      ref={ref}
      src={visualUrl}
      poster={poster}
      controls={controls}
      muted={muted}
      loop={loop}
      playsInline={playsInline}
      onPlay={onPlay}
      onPause={onPause}
      onTimeUpdate={onTimeUpdate}
      onSeeked={onSeeked}
    />
  );
});

function CameraPathPreview({ videoUrl, poster, cameraMotionData }: { videoUrl: string; poster?: string; cameraMotionData: CameraMotionData | null }) {
  const points = mapCameraPath(cameraMotionData);
  return (
    <div className="camera-path-preview">
      {videoUrl ? <MediaVisual url={videoUrl} poster={poster} muted loop playsInline /> : <EmptyPreview label="分析后显示摄影机路径" />}
      <div className="path-grid" />
      <svg className="camera-path-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points.map((point) => point.join(',')).join(' ')} />
        {points.map(([x, y], index) => (
          <circle key={`${x}-${y}-${index}`} cx={x} cy={y} r={index === points.length - 1 ? 2.8 : 1.8} />
        ))}
      </svg>
      <div className="camera-gizmo">
        <Camera size={30} />
      </div>
    </div>
  );
}

function PoseOverlayPreview({ frame, videoUrl, poster, width, height }: { frame?: PoseFrame; videoUrl: string; poster?: string; width: number; height: number }) {
  const poses = frame?.poses?.length
    ? frame.poses
    : frame?.landmarks?.length
      ? [{ id: 0, landmarks: frame.landmarks, worldLandmarks: frame.worldLandmarks, score: frame.score }]
      : [];
  if (!videoUrl && !frame) return <EmptyPreview label="跟踪后显示角色姿态" />;
  return (
    <div className="pose-overlay-preview">
      {videoUrl ? <MediaVisual url={videoUrl} poster={poster} muted loop playsInline /> : null}
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {poses.map((pose, poseIndex) => (
          <g key={pose.id} style={{ opacity: poseIndex === 0 ? 1 : 0.62 }}>
            {POSE_CONNECTIONS.map(([from, to], index) => {
              const a = pose.landmarks[from];
              const b = pose.landmarks[to];
              if (!a || !b) return null;
              const confident = Math.min(a.visibility ?? 1, b.visibility ?? 1) > 0.45;
              return (
                <line
                  key={`${pose.id}-${from}-${to}-${index}`}
                  x1={a.x * width}
                  y1={a.y * height}
                  x2={b.x * width}
                  y2={b.y * height}
                  stroke={poseConnectionColor(from, to)}
                  className={confident ? 'confident' : ''}
                />
              );
            })}
            {pose.landmarks.map((point, index) => (
              <circle key={`${pose.id}-${index}`} cx={point.x * width} cy={point.y * height} r={index <= 10 ? 5 : 7} className={index === 0 ? 'head-joint' : ''} />
            ))}
          </g>
        ))}
      </svg>
      <span className={frame?.source === 'filled' ? 'overlay-note filled' : 'overlay-note'}>
        {poses.length ? `${poses.length} 组姿态 · ${frame?.source === 'filled' ? '补帧' : '已跟踪'}` : '等待姿态跟踪'}
      </span>
    </div>
  );
}

function PoseAllPreview({ frame, poseData }: { frame?: PoseFrame; poseData: PoseData | null }) {
  const summary = poseData?.summary;
  return (
    <div className="pose-all-preview">
      <ThreePreview frame={frame} />
      <div className="stick-figure-hud">
        <span>{frame?.source === 'filled' ? '补帧画面' : frame?.landmarks?.length ? '已跟踪画面' : '暂无姿态'}</span>
        <strong>{summary ? `${summary.detectedFrames}/${summary.totalFrames || poseData?.frames.length || 0}` : '--'}</strong>
      </div>
    </div>
  );
}

function TransportBar({
  sampleFps,
  isPlaying,
  onPlayPause,
  onStepBack,
  onStepForward,
  onSkipStart,
  onSkipEnd,
  disabled
}: {
  sampleFps: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onSkipStart: () => void;
  onSkipEnd: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="transport-bar" aria-label="播放控制">
      <IconButton label="跳到开头" onClick={onSkipStart} disabled={disabled}>
        <SkipBack size={16} />
      </IconButton>
      <IconButton label="后退一帧" onClick={onStepBack} disabled={disabled}>
        <SkipBack size={14} />
      </IconButton>
      <IconButton label={isPlaying ? '暂停' : '播放'} onClick={onPlayPause} disabled={disabled}>
        {isPlaying ? <Pause size={17} /> : <Play size={17} />}
      </IconButton>
      <IconButton label="前进一帧" onClick={onStepForward} disabled={disabled}>
        <SkipForward size={14} />
      </IconButton>
      <IconButton label="跳到结尾" onClick={onSkipEnd} disabled={disabled}>
        <SkipForward size={16} />
      </IconButton>
      <span className="fps-chip">{sampleFps} fps</span>
      <div className="transport-spacer" />
    </div>
  );
}

function TimelineFilmstrip({ previewUrl, poster }: { previewUrl?: string; poster?: string }) {
  return (
    <div className="timeline-filmstrip" aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => (
        <ShotThumb key={index} previewUrl={previewUrl} poster={poster} />
      ))}
    </div>
  );
}

function StatusItem({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) {
  return (
    <div className="status-item">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingSelect({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label: string;
  value: string;
  options: { value: string; label: string; title?: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="select-row setting-control">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {options.map((option) => (
          <option key={option.value} value={option.value} title={option.title}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SettingSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <label className="slider-row setting-control">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} disabled={disabled} />
      <strong>{format(value)}</strong>
    </label>
  );
}

function StepperRow({
  label,
  value,
  suffix,
  onMinus,
  onPlus,
  disabled
}: {
  label: string;
  value: number;
  suffix?: string;
  onMinus: () => void;
  onPlus: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="stepper-row setting-control">
      <span>{label}</span>
      <div>
        <strong>
          {value}
          {suffix ? ` ${suffix}` : ''}
        </strong>
        <button type="button" onClick={onMinus} disabled={disabled} aria-label={`减少 ${label}`}>
          -
        </button>
        <button type="button" onClick={onPlus} disabled={disabled} aria-label={`增加 ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}

function PresetTile({
  preset,
  label,
  selected,
  disabled,
  onToggle
}: {
  preset: ExportPreset;
  label: string;
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const accent = PRESET_ACCENTS[preset];
  return (
    <button className={selected ? 'preset-card selected' : 'preset-card'} type="button" onClick={onToggle} disabled={disabled} aria-pressed={selected}>
      <span className="preset-logo" style={{ color: accent }}>
        {label.slice(0, 1)}
      </span>
      <strong>{label}</strong>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ExternalLinkButton({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="external-link"
      onClick={() => {
        if (window.motionPrevis?.openExternal) {
          void window.motionPrevis.openExternal(url);
          return;
        }
        window.open(url, '_blank', 'noopener,noreferrer');
      }}
    >
      {children}
    </button>
  );
}

function BrainGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M6.4 3.1c-1.7.1-3 1.4-3 3 0 .4.1.7.2 1A3.4 3.4 0 0 0 5 13.7c.6.7 1.5 1.1 2.5 1.1h3c1 0 1.9-.4 2.5-1.1a3.4 3.4 0 0 0 1.4-6.6c.1-.3.2-.6.2-1 0-1.6-1.3-2.9-3-3-.7-1-1.8-1.5-3.1-1.5S7.1 2.1 6.4 3.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8.9 3.2v11.5M6.1 6.3h2.8M8.9 9H6M8.9 11.9H6.7M11.8 6.3H9M12 9H9M11.3 11.9H9" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FilmIcon() {
  return (
    <svg width="22" height="18" viewBox="0 0 22 18" aria-hidden="true">
      <rect x="2" y="2" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 2v14M16 2v14M2 6h4M16 6h4M2 12h4M16 12h4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function selectPoseFrame(poseData: PoseData | null, time: number): PoseFrame | undefined {
  if (!poseData?.frames.length) return undefined;
  const index = clamp(Math.round(time * poseData.fps), 0, poseData.frames.length - 1);
  return poseData.frames[index];
}

function workflowStepForStage(stage: Stage) {
  if (stage === 'exporting' || stage === 'exported') return 3;
  if (stage === 'ready') return 2;
  if (stage === 'preparing' || stage === 'tracking') return 1;
  return 0;
}

function mapCameraPath(cameraMotionData: CameraMotionData | null): [number, number][] {
  const frames = cameraMotionData?.frames || [];
  if (!frames.length) {
    return [
      [14, 70],
      [28, 60],
      [42, 54],
      [55, 58],
      [68, 66],
      [83, 77]
    ];
  }
  const sampled = frames.filter((_, index) => index % Math.max(1, Math.floor(frames.length / 7)) === 0).slice(0, 8);
  const maxPan = Math.max(1, ...sampled.map((frame) => Math.abs(frame.cameraMove.pan)));
  const maxTilt = Math.max(1, ...sampled.map((frame) => Math.abs(frame.cameraMove.tilt)));
  return sampled.map((frame, index) => {
    const x = 14 + (index / Math.max(sampled.length - 1, 1)) * 72 + (frame.cameraMove.pan / maxPan) * 5;
    const y = 68 + (frame.cameraMove.tilt / maxTilt) * 18;
    return [clamp(x, 8, 92), clamp(y, 24, 88)];
  });
}

function translateQuality(value: QualityReport['readiness'] | QualityReport['tracking']) {
  return QUALITY_LABELS[value] || value;
}

function isImageUrl(value?: string) {
  return Boolean(value && /^(data:image\/|blob:|https?:\/\/.*\.(?:png|jpg|jpeg|webp|svg)(?:\?|$))/i.test(value));
}
function formatDisplayDate(value?: string) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function isBusy(stage: Stage) {
  return stage === 'importing' || stage === 'preparing' || stage === 'tracking' || stage === 'exporting';
}

// Map the fine-grained UI stage onto the coarse analysis status the agent polls.
function controlAnalysisStatus(stage: Stage): ControlState['analysis']['status'] {
  if (stage === 'preparing' || stage === 'tracking' || stage === 'exporting') return 'running';
  if (stage === 'ready' || stage === 'exported') return 'done';
  if (stage === 'error') return 'error';
  return 'idle';
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00.00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds - mins * 60;
  return `${mins}:${secs.toFixed(2).padStart(5, '0')}`;
}

function toShotTitle(name: string) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return '镜头 01A';
  return `镜头 · ${base.slice(0, 42)}`;
}






