// 简谱图片查看器 —— 导入（文件/拖拽/粘贴）、滚轮缩放到光标、拖拽平移、
// ≤2MB 时缓存到 localStorage（下次自动恢复）。

const CACHE_KEY = "hp_sheet_img";
const CACHE_MAX = 2 * 1024 * 1024;
const MIN_SCALE = 0.2, MAX_SCALE = 5;

export class SheetView {
  constructor(container, { img, onToast, onChange }){
    this.container = container;
    this.img = img;
    this.onToast = onToast || (()=>{});
    this.onChange = onChange || (()=>{});
    this.scale = 1; this.x = 0; this.y = 0;
    this._url = null;
    this._bind();
  }

  hasImage(){ return this.img.classList.contains("loaded"); }

  loadFromBlob(blob, { silent = false } = {}){
    if (!/^image\//.test(blob.type)){
      this.onToast("只支持图片文件（png / jpg / webp）");
      return;
    }
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = URL.createObjectURL(blob);
    this.img.onload = () => {
      this.img.classList.add("loaded");
      this.container.classList.add("has-img");
      this.resetView();
      this.onChange();
    };
    this.img.src = this._url;
    this._cache(blob);
    if (!silent) this.onToast("已载入简谱图片");
  }

  loadFromUrl(url){ // localStorage 恢复
    this.img.onload = () => {
      this.img.classList.add("loaded");
      this.container.classList.add("has-img");
      this.resetView();
      this.onChange();
    };
    this.img.src = url;
  }

  clear({ silent = false } = {}){
    if (this._url){ URL.revokeObjectURL(this._url); this._url = null; }
    this.img.removeAttribute("src");
    this.img.classList.remove("loaded");
    this.container.classList.remove("has-img");
    localStorage.removeItem(CACHE_KEY);
    this.onChange();
    if (!silent) this.onToast("已清除简谱图片");
  }

  restoreFromCache(){
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) this.loadFromUrl(cached);
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  _cache(blob){
    try {
      if (blob.size > CACHE_MAX){
        this.onToast("图片较大（>2MB），本次练习结束后不会保留");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { try { localStorage.setItem(CACHE_KEY, reader.result); } catch (e) {} };
      reader.readAsDataURL(blob);
    } catch (e) { /* 忽略缓存失败 */ }
  }

  // ---- 视图变换 ----
  resetView(){ this.scale = 1; this.x = 0; this.y = 0; this._apply(); this.fitWidth(); }
  fitWidth(){
    if (!this.hasImage()) return;
    const cw = this.container.clientWidth;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cw / this.img.naturalWidth));
    this.x = 0; this.y = 0;
    this._apply();
  }
  zoomBy(k, cx, cy){
    const s0 = this.scale, s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s0 * k));
    if (cx === undefined){
      cx = this.container.clientWidth / 2;
      cy = this.container.clientHeight / 2;
    }
    this.x = cx - (cx - this.x) * s1 / s0;
    this.y = cy - (cy - this.y) * s1 / s0;
    this.scale = s1;
    this._apply();
  }
  _apply(){
    this.img.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
  }

  // ---- 交互 ----
  _bind(){
    const c = this.container;

    c.addEventListener("wheel", e => {
      if (!this.hasImage()) return;
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    let panning = null;
    c.addEventListener("pointerdown", e => {
      if (!this.hasImage() || e.button !== 0) return;
      panning = { x: e.clientX, y: e.clientY, ox: this.x, oy: this.y };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", e => {
      if (!panning) return;
      this.x = panning.ox + (e.clientX - panning.x);
      this.y = panning.oy + (e.clientY - panning.y);
      this._apply();
    });
    const endPan = () => { panning = null; };
    c.addEventListener("pointerup", endPan);
    c.addEventListener("pointercancel", endPan);

    // 拖拽导入
    c.addEventListener("dragover", e => {
      e.preventDefault();
      if (!this.hasImage()) c.classList.add("dragover");
    });
    c.addEventListener("dragleave", () => c.classList.remove("dragover"));
    c.addEventListener("drop", e => {
      e.preventDefault();
      c.classList.remove("dragover");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.loadFromBlob(f);
    });
  }

  // 剪贴板粘贴（仅在简谱模式激活时由 main 调用）
  handlePaste(e){
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items){
      if (it.type && it.type.startsWith("image/")){
        const f = it.getAsFile();
        if (f){ this.loadFromBlob(f); e.preventDefault(); }
        return;
      }
    }
  }
}
