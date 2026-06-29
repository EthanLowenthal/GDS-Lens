const canvas = document.getElementById("glCanvas");
const gl = canvas.getContext("webgl2");
const ui = document.getElementById("ui");
const scaleLabel = document.getElementById("scaleLabel");
const scaleBar = document.getElementById("scaleBar");
const lypBtn = document.getElementById("lypBtn");

const vscode = acquireVsCodeApi();

if (!gl) { ui.innerText = "Error: WebGL2 context failed."; }

const vsSource = `#version 300 es\n` +
    `in vec2 a_position;\n` +
    `uniform vec2 u_resolution;\n` +
    `uniform vec2 u_offset;\n` +
    `uniform float u_zoom;\n` +
    `void main() {\n` +
    `    vec2 centeredPos = a_position - u_offset;\n` +
    `    vec2 zoomedPos = centeredPos * u_zoom;\n` +
    `    vec2 clipSpace = (zoomedPos / u_resolution) * 2.0;\n` +
    `    gl_Position = vec4(clipSpace.x, clipSpace.y, 0.0, 1.0);\n` +
    `}`;

const fsSource = `#version 300 es\n` +
    `precision highp float;\n` +
    `uniform vec4 u_color;\n` +
    `out vec4 fragColor;\n` +
    `void main() { fragColor = u_color; }`;

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
}

const program = gl.createProgram();
gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vsSource));
gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
gl.linkProgram(program);

const positionAttributeLocation = gl.getAttribLocation(program, "a_position");
const resolutionUniformLocation = gl.getUniformLocation(program, "u_resolution");
const colorUniformLocation = gl.getUniformLocation(program, "u_color");
const offsetUniformLocation = gl.getUniformLocation(program, "u_offset");
const zoomUniformLocation = gl.getUniformLocation(program, "u_zoom");

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

let zoom = 1.0; let panX = 0.0; let panY = 0.0; let renderData = [];
let isDragging = false; let lastMouseX = 0; let lastMouseY = 0;
let dbuPerMicron = 1000.0;
let lypColorMap = {}; 

lypBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'loadLypFile' });
});

function hexToRgb(hexStr) {
    if (!hexStr) return null;
    const cleanHex = hexStr.replace('#', '').trim();
    if (cleanHex.length !== 6) return null;
    const r = parseInt(cleanHex.substring(0, 2), 16) / 255.0;
    const g = parseInt(cleanHex.substring(2, 4), 16) / 255.0;
    const b = parseInt(cleanHex.substring(4, 6), 16) / 255.0;
    return [r, g, b, 0.8];
}

function parseLypText(xmlText) {
    const colorMap = {};
    const propertyBlocks = xmlText.split(/<properties>/g);
    
    propertyBlocks.forEach(block => {
        const sourceMatch = block.match(/<source>([^<]+)<\/source>/);
        const colorMatch = block.match(/<fill-color>([^<]+)<\/fill-color>/) || block.match(/<frame-color>([^<]+)<\/frame-color>/);
        
        if (sourceMatch && colorMatch) {
            const sourceText = sourceMatch[1].trim();
            const colorHex = colorMatch[1].trim();
            const layerNum = parseInt(sourceText.split('/')[0]);
            const rgb = hexToRgb(colorHex);
            if (!isNaN(layerNum) && rgb) {
                colorMap[layerNum] = rgb;
            }
        }
    });
    return colorMap;
}

function updateScaleBar() {
    const targetPixelWidth = 120;
    const rawUnits = (targetPixelWidth / zoom);
    const micronsValue = rawUnits / dbuPerMicron;
    const magnitude = Math.pow(10, Math.floor(Math.log10(micronsValue)));
    const normalized = micronsValue / magnitude;
    let step = magnitude;
    if (normalized >= 5) step = 5 * magnitude;
    else if (normalized >= 2) step = 2 * magnitude;
    const finalBarPixels = step * dbuPerMicron * zoom;
    scaleBar.style.width = finalBarPixels + "px";
    
    if (step >= 1000) {
        scaleLabel.innerText = (step / 1000).toFixed(1) + " mm";
    } else if (step >= 1) {
        scaleLabel.innerText = step.toFixed(0) + " μm";
    } else {
        scaleLabel.innerText = (step * 1000).toFixed(0) + " nm";
    }
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
    updateScaleBar();
    requestAnimationFrame(drawScene);
}
window.addEventListener("resize", resize);
resize();

window.addEventListener("message", event => {
    const message = event.data;
    if (message.type === 'lypLoaded') {
        const parsedColors = parseLypText(message.text);
        Object.assign(lypColorMap, parsedColors);
        renderData.forEach(item => {
            if (lypColorMap[item.layer]) { item.color = lypColorMap[item.layer]; }
        });
        requestAnimationFrame(drawScene);
    }
    else if (message.type === 'init') {
        renderData = [];
        dbuPerMicron = message.dbuPerMicron || 1000.0;
        let minX = Infinity, maxX = -Infinity; let minY = Infinity, maxY = -Infinity;
        let validCoordsFound = false;

        message.geometry.forEach(poly => {
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(poly.points), gl.STATIC_DRAW);
            
            for (let i = 0; i < poly.points.length; i += 2) {
                const x = poly.points[i]; const y = poly.points[i+1];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                validCoordsFound = true;
            }

            let color = lypColorMap[poly.layer];
            if (!color) {
                const r = ((poly.layer * 65) % 200 + 55) / 255;
                const g = ((poly.layer * 115) % 200 + 55) / 255;
                const b = ((poly.layer * 175) % 200 + 55) / 255;
                color = [r, g, b, 0.8];
            }

            renderData.push({ 
                buffer: buffer, 
                count: poly.points.length / 2, 
                color: color,
                layer: poly.layer
            });
        });

        if (validCoordsFound) {
            const totalWidth = maxX - minX; const totalHeight = maxY - minY;
            panX = minX + (totalWidth / 2); panY = minY + (totalHeight / 2);
            const zoomX = canvas.width / (totalWidth || 1);
            const zoomY = canvas.height / (totalHeight || 1);
            zoom = Math.min(zoomX, zoomY) * 0.85;
        }

        ui.innerHTML = "<b>GDSII Core Engine Active</b><br>Polygons: " + renderData.length;
        updateScaleBar();
        requestAnimationFrame(drawScene);
    }
});

function drawScene() {
    if (renderData.length === 0) return;
    gl.clearColor(0.06, 0.06, 0.07, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vao);

    gl.uniform2f(resolutionUniformLocation, canvas.width, canvas.height);
    gl.uniform2f(offsetUniformLocation, panX, panY);
    gl.uniform1f(zoomUniformLocation, zoom);

    renderData.forEach(item => {
        gl.bindBuffer(gl.ARRAY_BUFFER, item.buffer);
        gl.enableVertexAttribArray(positionAttributeLocation);
        gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);
        gl.uniform4fv(colorUniformLocation, item.color);
        gl.drawArrays(gl.LINE_LOOP, 0, item.count);
    });
}

window.addEventListener("mousedown", e => { isDragging = true; lastMouseX = e.clientX; lastMouseY = e.clientY; });
window.addEventListener("mousemove", e => {
    if (!isDragging) return;
    const dx = e.clientX - lastMouseX; const dy = e.clientY - lastMouseY;
    panX -= (dx / zoom); panY += (dy / zoom); 
    lastMouseX = e.clientX; lastMouseY = e.clientY;
    requestAnimationFrame(drawScene);
});
window.addEventListener("mouseup", () => isDragging = false);
window.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.deltaY < 0) { zoom *= 1.15; } else { zoom /= 1.15; }
    updateScaleBar();
    requestAnimationFrame(drawScene);
}, { passive: false });
