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

    // touch-action: none tira do Safari qualquer chance de interpretar o toque como um gesto
    // de rolar/dar zoom na página — sem isso, o reconhecedor de gestos nativo às vezes "rouba"
    // o toque no meio de um traço. Rolagem, zoom e pan de dois dedos são feitos manualmente
    // abaixo, então tudo continua funcionando, só que sem essa disputa.
    this.canvas.style.touchAction = 'none';
    this.scrollEl = this.canvas.closest('.canvas-scroll');
    this.pageStage = this.canvas.closest('.page-stage');

    this._touches = new Map(); // pointerId (toque) -> {x,y} na tela
    this._panState = null;     // rolagem vertical com 1 dedo (zoom em 1x)
    this._dragState = null;    // pan com 1 dedo (quando já está com zoom)
    this._pinchState = null;   // pinça com 2 dedos
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    this._lastTapTime = 0;
    this._lastTapPos = null;
    this._strokeRect = null; // bounding rect "congelado" durante um traço, evita reflow a cada ponto

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

  _norm(e, rect) {
    const r = rect || this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height
    };
  }

  _capture(pointerId) {
    // setPointerCapture pode falhar em alguns navegadores/situações; a captura é só uma
    // garantia extra (mantém os eventos chegando aqui mesmo se o dedo/caneta sair da área do
    // canvas), então uma falha aqui não deve impedir o resto do gesto de funcionar.
    try { this.canvas.setPointerCapture(pointerId); } catch (err) { /* segue sem captura */ }
  }

  // ---------- zoom com dois dedos ----------
  _applyZoomTransform() {
    if (!this.pageStage) return;
    const { scale, tx, ty } = this._zoom;
    this.pageStage.style.transform = (scale === 1 && tx === 0 && ty === 0)
      ? ''
      : `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  _resetZoom() {
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    this._applyZoomTransform();
  }

  _beginPinch() {
    const pts = Array.from(this._touches.values());
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    const rect = this.pageStage.getBoundingClientRect();
    this._pinchState = {
      startDist: dist,
      startScale: this._zoom.scale,
      startTx: this._zoom.tx,
      startTy: this._zoom.ty,
      rx: midX - rect.left,
      ry: midY - rect.top
    };
  }

  _updatePinch() {
    const pts = Array.from(this._touches.values());
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const { startDist, startScale, startTx, startTy, rx, ry } = this._pinchState;
    let scale = startScale * (dist / startDist);
    scale = Math.max(1, Math.min(4, scale));
    const ratio = 1 - scale / startScale;
    this._zoom.scale = scale;
    this._zoom.tx = startTx + rx * ratio;
    this._zoom.ty = startTy + ry * ratio;
    this._applyZoomTransform();
  }

  // depois que solta um dos dois dedos da pinça, retoma pan/rolagem normal com o dedo que sobrou
  _resumeSingleTouch(pointerId, pos) {
    if (this._zoom.scale > 1) {
      this._dragState = { pointerId, startX: pos.x, startY: pos.y, startTx: this._zoom.tx, startTy: this._zoom.ty };
    } else {
      this._panState = { pointerId, startY: pos.y, startScrollTop: this.scrollEl ? this.scrollEl.scrollTop : 0 };
    }
  }

  // ---------- entrada (caneta, mouse, dedo) ----------
  _onDown(e) {
    if (e.pointerType === 'touch') {
      e.preventDefault();
      this._capture(e.pointerId);

      if (this._touches.size === 0) {
        const now = Date.now();
        const isDoubleTap = this._lastTapPos
          && (now - this._lastTapTime) < 300
          && Math.hypot(e.clientX - this._lastTapPos.x, e.clientY - this._lastTapPos.y) < 30;
        this._lastTapTime = now;
        this._lastTapPos = { x: e.clientX, y: e.clientY };
        if (isDoubleTap && this._zoom.scale !== 1) {
          this._resetZoom();
          this._panState = null;
          this._dragState = null;
          this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
          return;
        }
      }

      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._touches.size === 2) {
        this._panState = null;
        this._dragState = null;
        this._beginPinch();
      } else if (this._touches.size === 1) {
        this._resumeSingleTouch(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      return;
    }

    // caneta / mouse
    e.preventDefault();
    this._capture(e.pointerId);
    this.redoStack = [];
    this._strokeRect = this.canvas.getBoundingClientRect();
    const pt = this._norm(e, this._strokeRect);
    this.currentStroke = { tool: this.tool, color: this.color, width: Number(this.width), points: [pt] };
  }

  _onMove(e) {
    if (e.pointerType === 'touch') {
      if (!this._touches.has(e.pointerId)) return;
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pinchState && this._touches.size === 2) {
        this._updatePinch();
        return;
      }
      if (this._dragState && e.pointerId === this._dragState.pointerId) {
        this._zoom.tx = this._dragState.startTx + (e.clientX - this._dragState.startX);
        this._zoom.ty = this._dragState.startTy + (e.clientY - this._dragState.startY);
        this._applyZoomTransform();
        return;
      }
      if (this._panState && e.pointerId === this._panState.pointerId) {
        if (this.scrollEl) {
          const dy = e.clientY - this._panState.startY;
          this.scrollEl.scrollTop = this._panState.startScrollTop - dy;
        }
        return;
      }
      return;
    }

    if (!this.currentStroke) return;
    e.preventDefault();
    // getCoalescedEvents recupera as amostras de alta frequência da Apple Pencil que o
    // navegador às vezes agrupa num único pointermove — usar todas deixa o traço mais fiel
    // e fluido, mais perto do que dá pra ver no Excel/apps nativos de desenho.
    const events = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length)
      ? e.getCoalescedEvents()
      : [e];
    for (const ev of events) {
      const prev = this.currentStroke.points[this.currentStroke.points.length - 1];
      const pt = this._norm(ev, this._strokeRect);
      this.currentStroke.points.push(pt);
      this._drawIncrementalSegment(prev, pt);
    }
  }

  _onUp(e) {
    if (e.pointerType === 'touch') {
      this._touches.delete(e.pointerId);
      if (this._touches.size < 2) this._pinchState = null;
      if (this._panState && e.pointerId === this._panState.pointerId) this._panState = null;
      if (this._dragState && e.pointerId === this._dragState.pointerId) this._dragState = null;
      if (this._touches.size === 1) {
        const [[pid, pos]] = this._touches;
        this._resumeSingleTouch(pid, pos);
      }
      return;
    }

    if (!this.currentStroke) return;
    if (this.currentStroke.points.length > 1) {
      this.strokes.push(this.currentStroke);
      if (this.onChange) this.onChange();
    }
    this.currentStroke = null;
    this._strokeRect = null;
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

  // Desenha só o novo segmento (do ponto anterior até o novo) por cima do que já está no
  // canvas, sem limpar nem redesenhar os traços anteriores. É o que mantém a caneta fluida
  // mesmo com a ficha cheia de anotações — redesenhar tudo a cada movimento é o que travava.
  _drawIncrementalSegment(prevPt, pt) {
    if (!this._strokeRect) return;
    const w = this._strokeRect.width, h = this._strokeRect.height;
    const mini = { tool: this.currentStroke.tool, color: this.currentStroke.color, width: this.currentStroke.width, points: [prevPt, pt] };
    PageDrawer._drawStroke(this.ctx, mini, w, h);
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
