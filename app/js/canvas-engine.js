// Motor de desenho: uma camada <canvas> transparente sobre a imagem de fundo da planilha.
// Estratégia: cada traço fica salvo como pontos normalizados (0..1), independente da
// resolução da tela. Isso permite redesenhar em qualquer tamanho (tela do iPad, Android,
// export final em alta resolução) sem perder proporção.

class PageDrawer {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.strokes = [];
    this.redoStack = [];
    this.currentStroke = null;
    this.tool = 'pen';
    this.color = '#1b1b1b';
    this.width = 3;
    this.onChange = null;

    this.canvas.style.touchAction = 'pan-y';
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointercancel', this._onUp);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.canvas);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  _norm(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height
    };
  }

  _onDown(e) {
    if (e.pointerType === 'touch') return; // dedo = rolar a tela, só caneta/mouse desenha
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.redoStack = [];
    this.currentStroke = { tool: this.tool, color: this.color, width: Number(this.width), points: [this._norm(e)] };
  }

  _onMove(e) {
    if (!this.currentStroke) return;
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    this.currentStroke.points.push(this._norm(e));
    this.redraw();
  }

  _onUp(e) {
    if (!this.currentStroke) return;
    if (this.currentStroke.points.length > 1) {
      this.strokes.push(this.currentStroke);
      if (this.onChange) this.onChange();
    }
    this.currentStroke = null;
    this.redraw();
  }

  setTool(tool) { this.tool = tool; }
  setColor(c) { this.color = c; }
  setWidth(w) { this.width = w; }

  undo() {
    if (!this.strokes.length) return false;
    this.redoStack.push(this.strokes.pop());
    this.redraw();
    if (this.onChange) this.onChange();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.strokes.push(this.redoStack.pop());
    this.redraw();
    if (this.onChange) this.onChange();
    return true;
  }

  loadStrokes(strokes) {
    this.strokes = strokes ? JSON.parse(JSON.stringify(strokes)) : [];
    this.redoStack = [];
    this.redraw();
  }

  addStrokes(strokes) {
    if (!strokes || !strokes.length) return;
    this.strokes.push(...JSON.parse(JSON.stringify(strokes)));
    this.redraw();
    if (this.onChange) this.onChange();
  }

  getStrokes() {
    return this.strokes;
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  static _drawStroke(ctx, stroke, w, h) {
    if (stroke.points.length < 2) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (stroke.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = stroke.width * 4;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
    }
    ctx.beginPath();
    stroke.points.forEach((pt, i) => {
      const x = pt.x * w, y = pt.y * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  redraw() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const s of this.strokes) PageDrawer._drawStroke(this.ctx, s, w, h);
    if (this.currentStroke) PageDrawer._drawStroke(this.ctx, this.currentStroke, w, h);
  }

  // Renderiza os traços num canvas separado, em alta resolução, para exportação em PDF.
  renderToImage(targetW, targetH) {
    const off = document.createElement('canvas');
    off.width = targetW;
    off.height = targetH;
    const octx = off.getContext('2d');
    for (const s of this.strokes) PageDrawer._drawStroke(octx, s, targetW, targetH);
    return off.toDataURL('image/png');
  }
}
