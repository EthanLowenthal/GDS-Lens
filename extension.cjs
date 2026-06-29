const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const logger = vscode.window.createOutputChannel("GDSII Debugger");

function activate(context) {
    logger.show(true);
    logger.appendLine(">>> GDSII Extension Core Spinning Up via native parseGDS loop...");
    
    const provider = new GdsEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('gdsii-view.editor', provider)
    );
}

class GdsEditorProvider {
    constructor(context) {
        this.context = context;
    }

    async openCustomDocument(uri, openContext, token) {
        return {
            uri: uri,
            onDidDispose: new vscode.EventEmitter().event,
            dispose: () => {}
        };
    }

        async resolveCustomEditor(document, webviewPanel, _token) {
        try {
            // 1. Grant permission to execute scripts and access local extensions directories
            webviewPanel.webview.options = { 
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(this.context.extensionPath)]
            };

            // 2. Fetch the absolute disk file path vectors
            const htmlPath = path.join(this.context.extensionPath, 'viewer.html');
            const jsPath = path.join(this.context.extensionPath, 'viewer.js');

            // 3. Convert the native viewer.js file path into an authenticated Webview URI
            const jsWebviewUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(jsPath));

            // 4. Load the base HTML text and dynamically swap out the standard script reference
            let htmlContent = fs.readFileSync(htmlPath, 'utf8');
            htmlContent = htmlContent.replace('src="viewer.js"', 'src="' + jsWebviewUri.toString() + '"');
            
            webviewPanel.webview.html = htmlContent;

            logger.appendLine('\n>>> Intercepted layout open call for file: ' + document.uri.fsPath);
            const fileData = await vscode.workspace.fs.readFile(document.uri);
            
            const gdsiiModule = await import('gdsii');
            const parseGDS = gdsiiModule.parseGDS || gdsiiModule.default?.parseGDS;
            const RecordType = gdsiiModule.RecordType || gdsiiModule.default?.RecordType;

            if (typeof parseGDS !== 'function') {
                throw new Error("Could not find the 'parseGDS' function inside package exports.");
            }

            const result = this.parseWithOfficialLibrary(fileData, parseGDS, RecordType);

            webviewPanel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'loadLypFile') {
                    const options = {
                        canSelectMany: false,
                        openLabel: 'Load Layer Properties',
                        filters: { 'KLayout Properties': ['lyp'] }
                    };
                    const fileUri = await vscode.window.showOpenDialog(options);
                    if (fileUri && fileUri[0]) {
                        const lypRawText = fs.readFileSync(fileUri[0].fsPath, 'utf8');
                        webviewPanel.webview.postMessage({
                            type: 'lypLoaded',
                            text: lypRawText
                        });
                    }
                }
            });

            logger.appendLine('>>> Streaming parsed data payload down into WebGL Webview context...');
            webviewPanel.webview.postMessage({
                type: 'init',
                geometry: result.geometry,
                dbuPerMicron: result.dbuPerMicron
            });
        } catch (err) {
            logger.appendLine('[FATAL CRASH ERROR] ' + err.stack);
            vscode.window.showErrorMessage("GDSII Viewer Error: " + err.message);
        }
    }


    parseWithOfficialLibrary(fileBuffer, parseGDS, RecordType) {
        logger.appendLine('>>> Iterating over official library binary generator stream...');
        const nodeBuffer = Buffer.from(fileBuffer);
        
        let dbuPerMicron = 1000.0;
        let structures = {};
        
        let currentStructureName = null;
        let currentLayer = 0;
        
        let activeSrefCellName = null;
        let activeSrefMirrorX = false;
        let activeSrefAngle = 0.0;
        let activeSrefMag = 1.0;
        
        let currentPolygons = [];
        let currentSrefs = [];

        for (const { tag, data } of parseGDS(nodeBuffer)) {
            const tagName = RecordType ? RecordType[tag] : tag;

            if (tag === 0x03 || tagName === 'UNITS') {
                if (Array.isArray(data) && data.length > 1 && data[1] > 0) {
                    dbuPerMicron = 1e-6 / data[1];
                    logger.appendLine('[Config] Grid Conversion Detected: 1 Micron = ' + dbuPerMicron + ' DB Units');
                }
            }
            else if (tag === 0x05 || tagName === 'BGNSTR') {
                currentPolygons = [];
                currentSrefs = [];
                currentStructureName = null;
                activeSrefCellName = null;
            }
            else if (tag === 0x06 || tagName === 'STRNAME') {
                currentStructureName = typeof data === 'string' ? data.trim() : String(data).trim();
            }
            else if (tag === 0x0D || tagName === 'LAYER') {
                currentLayer = Number(data);
            }
            else if (tag === 0x12 || tagName === 'SREF') {
                activeSrefCellName = null;
                activeSrefMirrorX = false;
                activeSrefAngle = 0.0;
                activeSrefMag = 1.0;
            }
            else if (tag === 0x16 || tagName === 'SNAME') {
                activeSrefCellName = typeof data === 'string' ? data.trim() : String(data).trim();
            }
            else if (tag === 0x1A || tagName === 'STRANS') {
                const flags = Number(data);
                activeSrefMirrorX = (flags & 0x8000) !== 0 || (flags & 0x01) !== 0;
            }
            else if (tag === 0x1B || tagName === 'MAG') {
                activeSrefMag = Number(data) || 1.0;
            }
            else if (tag === 0x1C || tagName === 'ANGLE') {
                activeSrefAngle = Number(data) || 0.0;
            }
            else if (tag === 0x10 || tagName === 'XY') {
                const flatPoints = Array.isArray(data) ? data.flat() : [];
                
                if (flatPoints.length >= 2) {
                    if (activeSrefCellName) {
                        const posY = flatPoints[flatPoints.length - 1];
                        const posX = flatPoints[flatPoints.length - 2];
                        
                        currentSrefs.push({
                            cell: activeSrefCellName,
                            x: posX || 0,
                            y: posY || 0,
                            mirrorX: activeSrefMirrorX,
                            angle: activeSrefAngle,
                            mag: activeSrefMag
                        });
                        activeSrefCellName = null; 
                    } else if (flatPoints.length >= 4) {
                        currentPolygons.push({
                            layer: currentLayer,
                            points: flatPoints
                        });
                    }
                }
            }
            else if (tag === 0x07 || tagName === 'ENDSTR') {
                if (currentStructureName) {
                    structures[currentStructureName] = {
                        polygons: currentPolygons,
                        srefs: currentSrefs
                    };
                }
                activeSrefCellName = null;
            }
        }

        const flattenedGeometry = [];

        function resolveStructure(cellName, offsetX, offsetY, cumulativeAngle, cumulativeMirrorX, cumulativeMag, depth) {
            if (depth > 128) return;
            const cell = structures[cellName];
            if (!cell) return;

            cell.polygons.forEach(poly => {
                const transformedPoints = [];
                const rad = (cumulativeAngle * Math.PI) / 180.0;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);

                for (let i = 0; i < poly.points.length; i += 2) {
                    let rx = poly.points[i] * cumulativeMag;
                    let ry = poly.points[i + 1] * cumulativeMag;

                    if (cumulativeMirrorX) {
                        ry = -ry;
                    }

                    let xRotated = rx * cos - ry * sin;
                    let yRotated = rx * sin + ry * cos;

                    transformedPoints.push(xRotated + offsetX);
                    transformedPoints.push(yRotated + offsetY);
                }

                flattenedGeometry.push({
                    layer: poly.layer,
                    points: transformedPoints
                });
            });

            cell.srefs.forEach(sref => {
                if (sref.cell && structures[sref.cell]) {
                    const rad = (cumulativeAngle * Math.PI) / 180.0;
                    const cos = Math.cos(rad);
                    const sin = Math.sin(rad);

                    let sx = sref.x * cumulativeMag;
                    let sy = sref.y * cumulativeMag;

                    if (cumulativeMirrorX) {
                        sy = -sy;
                    }

                    const shiftedX = offsetX + (sx * cos - sy * sin);
                    const shiftedY = offsetY + (sx * sin + sy * cos);

                    const combinedAngle = cumulativeAngle + (cumulativeMirrorX ? -sref.angle : sref.angle);
                    const combinedMirror = cumulativeMirrorX !== sref.mirrorX;
                    const combinedMag = cumulativeMag * sref.mag;

                    resolveStructure(sref.cell, shiftedX, shiftedY, combinedAngle, combinedMirror, combinedMag, depth + 1);
                }
            });
        }

        const cellNames = Object.keys(structures);
        if (cellNames.length > 0) {
            const referencedCells = new Set();
            cellNames.forEach(name => {
                structures[name].srefs.forEach(sref => {
                    if (sref.cell) referencedCells.add(sref.cell);
                });
            });

            let rootCellName = cellNames[cellNames.length - 1];
            const unreferenced = cellNames.filter(name => !referencedCells.has(name) && !name.startsWith('$$$'));
            
            if (unreferenced.length > 0) {
                const exactRootMatch = unreferenced.find(name => name === 'pl_gf_basic' || name === 'rel_demux');
                rootCellName = exactRootMatch || unreferenced[0];
            }

            logger.appendLine('>>> Selecting Top Root Structure: "' + rootCellName + '"');
            resolveStructure(rootCellName, 0, 0, 0.0, false, 1.0, 0);
            logger.appendLine('>>> Tree Flattening Output: Generated ' + flattenedGeometry.length + ' aggregate design geometry paths.\n');
        }

        return { geometry: flattenedGeometry, dbuPerMicron: dbuPerMicron };
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
