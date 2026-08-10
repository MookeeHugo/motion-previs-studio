/**
 * Motion Previs Studio Internationalization (i18n)
 * 支持英文/中文双语切换
 */
const translations = {
  en: {
    'app.title': 'Motion Previs Studio', 'project.new': 'New Project', 'project.save': 'Save', 'project.open': 'Open Video',
    'pose.title': 'Pose Data', 'pose.extract': 'Extract Poses', 'pose.clear': 'Clear Poses',
    'camera.title': 'Camera Motion', 'camera.track': 'Track Camera', 'camera.calibrate': 'Calibrate',
    'segment.title': 'Segments', 'segment.add': 'Add Segment', 'segment.delete': 'Delete Segment',
    'export.title': 'Export', 'export.poseData': 'Pose Data JSON', 'export.cameraPath': 'Camera Path',
    'toast.saved': 'Project saved', 'toast.extracted': 'Pose extraction complete',
  },
  zh: {
    'app.title': 'Motion Previs Studio', 'project.new': '新建项目', 'project.save': '保存', 'project.open': '打开视频',
    'pose.title': '姿态数据', 'pose.extract': '提取姿态', 'pose.clear': '清除姿态',
    'camera.title': '摄影机运动', 'camera.track': '跟踪摄影机', 'camera.calibrate': '校准',
    'segment.title': '分段', 'segment.add': '添加分段', 'segment.delete': '删除分段',
    'export.title': '导出', 'export.poseData': '姿态数据 JSON', 'export.cameraPath': '摄影机路径',
    'toast.saved': '项目已保存', 'toast.extracted': '姿态提取完成',
  }
};
function getCurrentLang() { return localStorage.getItem('motion-previs-lang') || 'zh'; }
function setLang(lang) { localStorage.setItem('motion-previs-lang', lang); window.dispatchEvent(new CustomEvent('langchange', { detail: lang })); }
function t(key) { const lang = getCurrentLang(); return translations[lang]?.[key] || translations.en[key] || key; }
function translatePage() { const lang = getCurrentLang(); document.querySelectorAll('[data-i18n]').forEach(el => { const k = el.getAttribute('data-i18n'); if (translations[lang]?.[k]) el.textContent = translations[lang][k]; }); document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === lang)); }
function initI18n() {
  // 默认设置为中文（强制）
  const savedLang = localStorage.getItem('motion-previs-lang');
  if (!savedLang || savedLang === 'en') {
    localStorage.setItem('motion-previs-lang', 'zh');
  }
  window.addEventListener('langchange', translatePage);
  translatePage();
}
window.t = t; window.setLang = setLang; window.getCurrentLang = getCurrentLang; window.initI18n = initI18n;
