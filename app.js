// ------------------------------
// Configuration (Instant Trigger)
// ------------------------------
const CONFIG = {
    LANDMARK_COLOR: '#ffffff',
    LINE_WIDTH: 1.2,
    DOT_RADIUS: 1.5,
    ACTIVATION_FRAMES: 1,          // Instant trigger as soon as conditions met
    TRIGGER_COOLDOWN: 1500,
    MOUTH_OPEN_THRESH: 0.025,
    SMILE_THRESH: 0.20,
    TOUCH_DIST_THRESH: 0.12,
    FINGER_EXTEND_THRESH_Y: 0.02,
    EYE_CLOSED_THRESH: 0.18,
    CHEST_PROXIMITY_THRESH: 0.20,
    EYES_UP_THRESH: 0.01,
};

const MEME_PATHS = {
    1: './point up.webp',
    2: './thinking monkey.webp',
    3: './image_745226.png',
    4: './image_745264.png',
    5: './image_745cee.png'
};

// ------------------------------
// Global UI Variables (all declared upfront)
// ------------------------------
let video, canvas, ctx;
let overlayDiv, memeImg, captionDiv, statusText, statusDot;
let controlPanel, togglePanelBtn;
let faceLandmarker, handLandmarker, poseLandmarker;
let isRunning = false;
let stream = null;
let currentMemeId = null;
let lastTriggerTime = 0;
let debugEnabled = false;

let startBtn, debugToggleBtn, debugOverlay, debugContent;
let mouthSlider, smileSlider, touchSlider;
let mouthVal, smileVal, touchVal;
let gestureCards = {};
let panelContent;  // defined early

// Debounce counters
const states = {
    1: { counter: 0, active: false },
    2: { counter: 0, active: false },
    3: { counter: 0, active: false },
    4: { counter: 0, active: false },
    5: { counter: 0, active: false }
};

// ------------------------------
// Helper Functions
// ------------------------------
function normalizedDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx*dx + dy*dy);
}

function isFingerExtended(landmarks, tipIdx, pipIdx) {
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    return (pip.y - tip.y) > CONFIG.FINGER_EXTEND_THRESH_Y;
}

function mouthOpenRatio(landmarks) {
    if (!landmarks) return 0;
    const upper = landmarks[13];
    const lower = landmarks[14];
    const left = landmarks[61];
    const right = landmarks[291];
    const height = Math.abs(upper.y - lower.y);
    const width = Math.abs(left.x - right.x);
    return width > 0 ? height / width : 0;
}

function smileRatio(landmarks) {
    if (!landmarks) return 0;
    const left = landmarks[61];
    const right = landmarks[291];
    const center = landmarks[13];
    const faceLeft = landmarks[234];
    const faceRight = landmarks[454];
    const faceWidth = Math.abs(faceRight.x - faceLeft.x);
    const stretch = Math.abs(left.x - center.x) + Math.abs(right.x - center.x);
    return stretch / faceWidth;
}

function eyeAspectRatio(landmarks, indices) {
    const v1 = landmarks[indices[1]];
    const v2 = landmarks[indices[2]];
    const h1 = landmarks[indices[0]];
    const h2 = landmarks[indices[3]];
    const vertical = Math.abs(v1.y - v2.y);
    const horizontal = Math.abs(h1.x - h2.x);
    return horizontal > 0 ? vertical / horizontal : 1;
}

function isGazingUp(landmarks) {
    const leftIris = landmarks[468];
    const rightIris = landmarks[473];
    const leftEyeCenter = landmarks[33];
    const rightEyeCenter = landmarks[263];
    const leftOffset = leftIris.y - leftEyeCenter.y;
    const rightOffset = rightIris.y - rightEyeCenter.y;
    const avgOffset = (leftOffset + rightOffset) / 2;
    return avgOffset < -CONFIG.EYES_UP_THRESH;
}

// ------------------------------
// Gesture Evaluators
// ------------------------------
function evaluateGesture1(hands, face, pose) {
    if (!hands.length || !face) return { result: false };
    let indexRaised = false;
    for (const hand of hands) {
        if (isFingerExtended(hand, 8, 6) && !isFingerExtended(hand, 12, 10)) {
            indexRaised = true;
            break;
        }
    }
    const mouthOpen = mouthOpenRatio(face) > CONFIG.MOUTH_OPEN_THRESH;
    const smile = smileRatio(face) > CONFIG.SMILE_THRESH;
    return { result: indexRaised && mouthOpen && smile, indexRaised, mouthOpen, smile };
}

function evaluateGesture2(hands, face, pose) {
    if (!hands.length || !face) return { result: false };
    const chin = face[152];
    let touching = false;
    for (const hand of hands) {
        const indexTip = hand[8];
        if (normalizedDistance(indexTip, chin) < CONFIG.TOUCH_DIST_THRESH) {
            touching = true;
            break;
        }
    }
    const eyesUp = isGazingUp(face);
    return { result: touching && eyesUp, touching, eyesUp };
}

function evaluateGesture3(hands, face, pose) {
    if (hands.length < 2 || !face || !pose) return { result: false };
    const leftShoulder = pose[11];
    const rightShoulder = pose[12];
    const chestX = (leftShoulder.x + rightShoulder.x) / 2;
    const chestY = (leftShoulder.y + rightShoulder.y) / 2;
    const chestCenter = { x: chestX, y: chestY };
    let handsOver = 0;
    for (const hand of hands) {
        const wrist = hand[0];
        if (normalizedDistance(wrist, chestCenter) < CONFIG.CHEST_PROXIMITY_THRESH) handsOver++;
    }
    const mouthOpen = mouthOpenRatio(face) > CONFIG.MOUTH_OPEN_THRESH * 1.3;
    return { result: handsOver >= 2 && mouthOpen, handsOver, mouthOpen };
}

function evaluateGesture4(hands, face, pose) {
    if (!hands.length || !face) return { result: false };
    let middleFingersRaised = 0;
    for (const hand of hands) {
        if (isFingerExtended(hand, 12, 10) && !isFingerExtended(hand, 8, 6) && !isFingerExtended(hand, 16, 14)) {
            middleFingersRaised++;
        }
    }
    const mouthClosed = mouthOpenRatio(face) < CONFIG.MOUTH_OPEN_THRESH * 0.8;
    const noSmile = smileRatio(face) < CONFIG.SMILE_THRESH * 0.7;
    const leftEAR = eyeAspectRatio(face, [33, 159, 158, 133]);
    const rightEAR = eyeAspectRatio(face, [362, 385, 386, 263]);
    const eyesOpen = leftEAR > CONFIG.EYE_CLOSED_THRESH && rightEAR > CONFIG.EYE_CLOSED_THRESH;
    return { result: middleFingersRaised >= 2 && mouthClosed && noSmile && eyesOpen, middleFingersRaised, mouthClosed, noSmile, eyesOpen };
}

function evaluateGesture5(hands, face, pose) {
    if (!hands.length || !face) return { result: false };
    const chin = face[152];
    let pointing = false;
    for (const hand of hands) {
        if (isFingerExtended(hand, 8, 6)) {
            const indexTip = hand[8];
            if (normalizedDistance(indexTip, chin) < CONFIG.TOUCH_DIST_THRESH) {
                pointing = true;
                break;
            }
        }
    }
    const leftEAR = eyeAspectRatio(face, [33, 159, 158, 133]);
    const rightEAR = eyeAspectRatio(face, [362, 385, 386, 263]);
    const leftClosed = leftEAR < CONFIG.EYE_CLOSED_THRESH;
    const rightClosed = rightEAR < CONFIG.EYE_CLOSED_THRESH;
    const wink = (leftClosed && !rightClosed) || (rightClosed && !leftClosed);
    return { result: pointing && wink, pointing, wink };
}

// ------------------------------
// Debounce and UI Update
// ------------------------------
function updateDebounceAndUI(evals, now) {
    let anyActive = false;
    let activeId = null;

    for (let id = 1; id <= 5; id++) {
        const state = states[id];
        const result = evals[id].result;
        
        if (result) {
            state.counter = Math.min(state.counter + 1, CONFIG.ACTIVATION_FRAMES);
        } else {
            state.counter = Math.max(state.counter - 1, 0);
        }
        state.active = state.counter >= CONFIG.ACTIVATION_FRAMES;
        
        const card = gestureCards[id];
        if (card) {
            const statusSpan = card.querySelector('.gesture-status');
            const progressPercent = (state.counter / CONFIG.ACTIVATION_FRAMES) * 100;
            
            if (state.active) {
                card.classList.add('active');
                statusSpan.textContent = 'ACTIVE';
                statusSpan.style.color = 'var(--success)';
            } else if (state.counter > 0) {
                card.classList.remove('active');
                statusSpan.textContent = 'detecting...';
                statusSpan.style.color = 'var(--warning)';
            } else {
                card.classList.remove('active');
                statusSpan.textContent = '—';
                statusSpan.style.color = 'var(--text-secondary)';
            }
        }
        
        if (state.active) {
            anyActive = true;
            activeId = id;
        }
    }

    if (anyActive && (now - lastTriggerTime) > CONFIG.TRIGGER_COOLDOWN) {
        if (currentMemeId !== activeId) {
            currentMemeId = activeId;
            lastTriggerTime = now;
        }
    } else if (!anyActive) {
        currentMemeId = null;
    }

    if (currentMemeId) {
        overlayDiv.classList.remove('hidden');
        memeImg.src = MEME_PATHS[currentMemeId];
        captionDiv.textContent = `Gesture ${currentMemeId}`;
        statusText.textContent = `Meme ${currentMemeId} Active`;
    } else {
        overlayDiv.classList.add('hidden');
        statusText.textContent = isRunning ? 'Tracking...' : 'Camera Off';
    }
    
    if (debugEnabled) {
        let debugStr = '';
        for (let id=1; id<=5; id++) {
            const e = evals[id];
            debugStr += `G${id}: ${e.result} | `;
            if (id===1) debugStr += `Idx:${e.indexRaised} M:${e.mouthOpen} S:${e.smile}\n`;
            else if (id===2) debugStr += `Touch:${e.touching} Up:${e.eyesUp}\n`;
            else if (id===3) debugStr += `Hands:${e.handsOver} M:${e.mouthOpen}\n`;
            else if (id===4) debugStr += `Mid:${e.middleFingersRaised} Stoic:${e.mouthClosed && e.noSmile && e.eyesOpen}\n`;
            else if (id===5) debugStr += `Point:${e.pointing} Wink:${e.wink}\n`;
        }
        debugContent.textContent = debugStr;
    }
}

// ------------------------------
// Drawing Landmarks – Full Face Mesh
// ------------------------------
function drawLandmarks(results) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = CONFIG.LANDMARK_COLOR;
    ctx.fillStyle = CONFIG.LANDMARK_COLOR;
    ctx.lineWidth = CONFIG.LINE_WIDTH;

    // Draw hand landmarks
    if (results.handLandmarks) {
        for (const landmarks of results.handLandmarks) {
            const connections = [
                [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
                [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
                [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]
            ];
            ctx.beginPath();
            for (const [i, j] of connections) {
                ctx.moveTo(landmarks[i].x * canvas.width, landmarks[i].y * canvas.height);
                ctx.lineTo(landmarks[j].x * canvas.width, landmarks[j].y * canvas.height);
            }
            ctx.stroke();
            for (const lm of landmarks) {
                ctx.beginPath();
                ctx.arc(lm.x * canvas.width, lm.y * canvas.height, CONFIG.DOT_RADIUS, 0, 2*Math.PI);
                ctx.fill();
            }
        }
    }

    // Draw full face mesh (tesselation lines) + dots
    if (results.faceLandmarks) {
        // Use MediaPipe's FACEMESH_TESSELATION connections (hardcoded for brevity)
        const faceConnections = window.mpFaceMeshConnections || [
            // These are the tesselation connections – we can approximate or use a subset.
            // For simplicity, we'll draw all landmarks as dots and a simplified wireframe.
        ];
        
        for (const landmarks of results.faceLandmarks) {
            // Draw dots for all 478 landmarks
            ctx.fillStyle = CONFIG.LANDMARK_COLOR;
            for (const lm of landmarks) {
                ctx.beginPath();
                ctx.arc(lm.x * canvas.width, lm.y * canvas.height, CONFIG.DOT_RADIUS * 0.7, 0, 2*Math.PI);
                ctx.fill();
            }
            
            // Draw face contours: jaw, eyebrows, lips, eyes, nose (simplified mesh)
            ctx.strokeStyle = CONFIG.LANDMARK_COLOR;
            ctx.lineWidth = 0.8;
            // Jawline (0 to 16)
            ctx.beginPath();
            for (let i = 0; i <= 16; i++) {
                const lm = landmarks[i];
                if (i === 0) ctx.moveTo(lm.x * canvas.width, lm.y * canvas.height);
                else ctx.lineTo(lm.x * canvas.width, lm.y * canvas.height);
            }
            ctx.stroke();
            
            // Left eyebrow (70,63,105,66,107...)
            const leftBrow = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
            ctx.beginPath();
            leftBrow.forEach((idx, i) => {
                const lm = landmarks[idx];
                if (i === 0) ctx.moveTo(lm.x * canvas.width, lm.y * canvas.height);
                else ctx.lineTo(lm.x * canvas.width, lm.y * canvas.height);
            });
            ctx.stroke();
            
            // Right eyebrow (300,293,334,296,336,285,295,282,283,276)
            const rightBrow = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
            ctx.beginPath();
            rightBrow.forEach((idx, i) => {
                const lm = landmarks[idx];
                if (i === 0) ctx.moveTo(lm.x * canvas.width, lm.y * canvas.height);
                else ctx.lineTo(lm.x * canvas.width, lm.y * canvas.height);
            });
            ctx.stroke();
            
            // Lips outer (61,146,91,181,84,17,314,405,321,375,291,308,324,318,402,317,14,87,178,88,95)
            const lipsOuter = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
            ctx.beginPath();
            lipsOuter.forEach((idx, i) => {
                const lm = landmarks[idx];
                if (i === 0) ctx.moveTo(lm.x * canvas.width, lm.y * canvas.height);
                else ctx.lineTo(lm.x * canvas.width, lm.y * canvas.height);
            });
            ctx.stroke();
            
            // Left eye (33,246,161,160,159,158,157,173,133,155,154,153,145,144,163,7)
            const leftEye = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
            ctx.beginPath();
            leftEye.forEach((idx, i) => {
                const lm = landmarks[idx];
                if (i === 0) ctx.moveTo(lm.x * canvas.width, lm.y * canvas.height);
                else ctx.lineTo(lm.x * canvas.width, lm.y * canvas.height);
            });
            ctx.stroke();
            
            // Right eye (362,398,384,385,386,387,388,466,263,249,390,373,374,380,381,382)
            const rightEye = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382];
            ctx.beginPath();
            rightEye.forEach((idx, i) => {
                const lm = landmarks[idx];
                if (i === 0) ctx.moveTo(lm.x * canvas.width, lm.y * canvas.height);
                else ctx.lineTo(lm.x * canvas.width, lm.y * canvas.height);
            });
            ctx.stroke();
        }
    }

    // Draw pose landmarks (shoulders/hips)
    if (results.poseLandmarks) {
        const points = [11, 12, 23, 24];
        ctx.fillStyle = CONFIG.LANDMARK_COLOR;
        for (const idx of points) {
            const lm = results.poseLandmarks[idx];
            ctx.beginPath();
            ctx.arc(lm.x * canvas.width, lm.y * canvas.height, CONFIG.DOT_RADIUS, 0, 2*Math.PI);
            ctx.fill();
        }
    }
}

// ------------------------------
// Frame Processing
// ------------------------------
async function processFrame() {
    if (!isRunning || !video.videoWidth) {
        requestAnimationFrame(processFrame);
        return;
    }
    const now = performance.now();
    let handResult, faceResult, poseResult;
    try {
        handResult = handLandmarker.detectForVideo(video, now);
        faceResult = faceLandmarker.detectForVideo(video, now);
        poseResult = poseLandmarker.detectForVideo(video, now);
    } catch (e) {
        requestAnimationFrame(processFrame);
        return;
    }
    const hands = handResult.landmarks || [];
    const face = faceResult.faceLandmarks?.[0] || null;
    const pose = poseResult.landmarks?.[0] || null;
    
    const evals = {
        1: evaluateGesture1(hands, face, pose),
        2: evaluateGesture2(hands, face, pose),
        3: evaluateGesture3(hands, face, pose),
        4: evaluateGesture4(hands, face, pose),
        5: evaluateGesture5(hands, face, pose)
    };
    
    updateDebounceAndUI(evals, now);
    
    if (!currentMemeId) {
        drawLandmarks({ handLandmarks: hands, faceLandmarks: faceResult.faceLandmarks, poseLandmarks: pose });
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    
    requestAnimationFrame(processFrame);
}

// ------------------------------
// Camera Initialization
// ------------------------------
async function startCamera() {
    console.log('Starting camera...');
    video.style.display = 'block';
    video.style.opacity = '1';
    
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
    }
    
    try {
        stream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: 640, height: 480, facingMode: 'user' } 
        });
        video.srcObject = stream;
        
        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                resolve();
            };
        });
        
        await video.play();
        statusText.textContent = 'Loading models...';
        statusDot.classList.remove('active');
        
        // Wait for MediaPipe
        if (typeof FilesetResolver === 'undefined') {
            console.error('MediaPipe not loaded');
            statusText.textContent = 'MediaPipe failed to load. Refresh.';
            return;
        }
        
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.11/wasm"
        );
        
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 2
        });
        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            outputFaceBlendshapes: false,
            numFaces: 1
        });
        poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numPoses: 1
        });
        
        isRunning = true;
        statusDot.classList.add('active');
        statusText.textContent = 'Ready';
        startBtn.innerHTML = '<span class="btn-icon">●</span> Restart Camera';
        processFrame();
        
    } catch (err) {
        console.error('Camera error:', err);
        statusText.textContent = 'Camera error: ' + err.message;
        statusDot.style.background = '#e74c3c';
    }
}

// ------------------------------
// UI Initialization
// ------------------------------
function initUI() {
    video = document.getElementById('video');
    canvas = document.getElementById('landmark-canvas');
    ctx = canvas.getContext('2d');
    overlayDiv = document.getElementById('meme-overlay');
    memeImg = document.getElementById('meme-image');
    captionDiv = document.getElementById('meme-caption');
    statusText = document.getElementById('status-text');
    statusDot = document.querySelector('.status-dot');
    controlPanel = document.getElementById('controlPanel');
    togglePanelBtn = document.getElementById('togglePanelBtn');
    startBtn = document.getElementById('startBtn');
    debugToggleBtn = document.getElementById('debugToggleBtn');
    debugOverlay = document.getElementById('debugOverlay');
    debugContent = document.getElementById('debugContent');
    panelContent = document.querySelector('.panel-content'); // Now defined
    
    mouthSlider = document.getElementById('mouthSlider');
    smileSlider = document.getElementById('smileSlider');
    touchSlider = document.getElementById('touchSlider');
    mouthVal = document.getElementById('mouthVal');
    smileVal = document.getElementById('smileVal');
    touchVal = document.getElementById('touchVal');
    
    mouthSlider.value = CONFIG.MOUTH_OPEN_THRESH;
    smileSlider.value = CONFIG.SMILE_THRESH;
    touchSlider.value = CONFIG.TOUCH_DIST_THRESH;
    mouthVal.textContent = CONFIG.MOUTH_OPEN_THRESH.toFixed(3);
    smileVal.textContent = CONFIG.SMILE_THRESH.toFixed(3);
    touchVal.textContent = CONFIG.TOUCH_DIST_THRESH.toFixed(3);
    
    for (let i=1; i<=5; i++) {
        gestureCards[i] = document.querySelector(`.gesture-card[data-gesture="${i}"]`);
    }
    
    mouthSlider.addEventListener('input', () => {
        CONFIG.MOUTH_OPEN_THRESH = parseFloat(mouthSlider.value);
        mouthVal.textContent = CONFIG.MOUTH_OPEN_THRESH.toFixed(3);
    });
    smileSlider.addEventListener('input', () => {
        CONFIG.SMILE_THRESH = parseFloat(smileSlider.value);
        smileVal.textContent = CONFIG.SMILE_THRESH.toFixed(3);
    });
    touchSlider.addEventListener('input', () => {
        CONFIG.TOUCH_DIST_THRESH = parseFloat(touchSlider.value);
        touchVal.textContent = CONFIG.TOUCH_DIST_THRESH.toFixed(3);
    });
    
    startBtn.addEventListener('click', startCamera);
    debugToggleBtn.addEventListener('click', () => {
        debugEnabled = !debugEnabled;
        debugOverlay.classList.toggle('hidden', !debugEnabled);
        debugToggleBtn.innerHTML = debugEnabled ? 
            '<span class="btn-icon">🔍</span> Hide Debug Info' : 
            '<span class="btn-icon">🔍</span> Show Debug Info';
    });
    togglePanelBtn.addEventListener('click', () => {
        controlPanel.classList.toggle('collapsed');
    });
    
    // Force show camera button
    const forceShowBtn = document.createElement('button');
    forceShowBtn.className = 'secondary-btn';
    forceShowBtn.innerHTML = '<span class="btn-icon">👁️</span> Force Show Camera';
    forceShowBtn.addEventListener('click', () => {
        video.style.display = 'block';
        video.style.opacity = '1';
        canvas.style.display = 'block';
        overlayDiv.classList.add('hidden');
        currentMemeId = null;
    });
    panelContent.appendChild(forceShowBtn);
    
    // Preload images
    for (let id in MEME_PATHS) {
        const img = new Image();
        img.src = MEME_PATHS[id];
    }
    
    startCamera();
}

window.addEventListener('load', initUI);
