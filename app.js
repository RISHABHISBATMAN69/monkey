// ------------------------------
// Configuration (dynamic via sliders)
// ------------------------------
const CONFIG = {
    LANDMARK_COLOR: '#ffffff',
    LINE_WIDTH: 1.2,
    DOT_RADIUS: 1.8,
    ACTIVATION_FRAMES: 3,
    TRIGGER_COOLDOWN: 2000, // ms

    // Default thresholds (will be updated by sliders)
    MOUTH_OPEN_THRESH: 0.04,
    SMILE_THRESH: 0.28,
    TOUCH_DIST_THRESH: 0.08,
    FINGER_EXTEND_THRESH_Y: 0.03,
    EYE_CLOSED_THRESH: 0.22,
    CHEST_PROXIMITY_THRESH: 0.15,
    EYES_UP_THRESH: 0.015,
};

// Meme mapping
const MEME_PATHS = {
    1: './point up.webp',
    2: './thinking monkey.webp',
    3: './image_745226.png',
    4: './image_745264.png',
    5: './image_745cee.png'
};

// Global state
let video, canvas, ctx;
let overlayDiv, memeImg, captionDiv, statusDiv;
let container;
let faceLandmarker, handLandmarker, poseLandmarker;
let isRunning = false;
let stream = null;

// Debounce state
const states = {
    1: { counter: 0, active: false },
    2: { counter: 0, active: false },
    3: { counter: 0, active: false },
    4: { counter: 0, active: false },
    5: { counter: 0, active: false }
};
let currentMemeId = null;
let lastTriggerTime = 0;

// Debug flags
let showDebug = false;
let lastDetectionResults = {};

// UI Elements
let startBtn, debugBtn, debugPanel;
let mouthSlider, smileSlider, touchSlider;
let mouthVal, smileVal, touchVal;
let gestureStatusDiv;

// ------------------------------
// Helper functions
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
    const upper = landmarks[13];
    const lower = landmarks[14];
    const left = landmarks[61];
    const right = landmarks[291];
    const height = Math.abs(upper.y - lower.y);
    const width = Math.abs(left.x - right.x);
    return width > 0 ? height / width : 0;
}

function smileRatio(landmarks) {
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
// Gesture evaluators (return boolean + debug info)
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
    return {
        result: indexRaised && mouthOpen && smile,
        indexRaised, mouthOpen, smile,
        mouthVal: mouthOpenRatio(face).toFixed(3),
        smileVal: smileRatio(face).toFixed(3)
    };
}

function evaluateGesture2(hands, face, pose) {
    if (!hands.length || !face) return { result: false };
    const chin = face[152];
    let touching = false;
    let dist = 1.0;
    for (const hand of hands) {
        const indexTip = hand[8];
        dist = normalizedDistance(indexTip, chin);
        if (dist < CONFIG.TOUCH_DIST_THRESH) {
            touching = true;
            break;
        }
    }
    const eyesUp = isGazingUp(face);
    return {
        result: touching && eyesUp,
        touching, eyesUp,
        touchDist: dist.toFixed(3)
    };
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
        if (normalizedDistance(wrist, chestCenter) < CONFIG.CHEST_PROXIMITY_THRESH) {
            handsOver++;
        }
    }
    const mouthOpen = mouthOpenRatio(face) > CONFIG.MOUTH_OPEN_THRESH * 1.3;
    return {
        result: handsOver >= 2 && mouthOpen,
        handsOver, mouthOpen,
        mouthVal: mouthOpenRatio(face).toFixed(3)
    };
}

function evaluateGesture4(hands, face, pose) {
    if (!hands.length || !face) return { result: false };
    let middleFingersRaised = 0;
    for (const hand of hands) {
        if (isFingerExtended(hand, 12, 10) &&
            !isFingerExtended(hand, 8, 6) &&
            !isFingerExtended(hand, 16, 14)) {
            middleFingersRaised++;
        }
    }
    const mouthClosed = mouthOpenRatio(face) < CONFIG.MOUTH_OPEN_THRESH * 0.8;
    const noSmile = smileRatio(face) < CONFIG.SMILE_THRESH * 0.7;
    const leftEAR = eyeAspectRatio(face, [33, 159, 158, 133]);
    const rightEAR = eyeAspectRatio(face, [362, 385, 386, 263]);
    const eyesOpen = leftEAR > CONFIG.EYE_CLOSED_THRESH && rightEAR > CONFIG.EYE_CLOSED_THRESH;
    return {
        result: middleFingersRaised >= 2 && mouthClosed && noSmile && eyesOpen,
        middleFingersRaised, mouthClosed, noSmile, eyesOpen
    };
}

function evaluateGesture5(hands, face, pose) {
    if (!hands.length || !face) return { result: false };
    const chin = face[152];
    let pointing = false;
    let dist = 1.0;
    for (const hand of hands) {
        if (isFingerExtended(hand, 8, 6)) {
            const indexTip = hand[8];
            dist = normalizedDistance(indexTip, chin);
            if (dist < CONFIG.TOUCH_DIST_THRESH) {
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
    return {
        result: pointing && wink,
        pointing, wink,
        touchDist: dist.toFixed(3)
    };
}

// ------------------------------
// Debounce & trigger
// ------------------------------
function updateDebounceAndTrigger(evaluations, now) {
    let anyActive = false;
    let activeId = null;

    for (let id = 1; id <= 5; id++) {
        const state = states[id];
        if (evaluations[id].result) {
            state.counter = Math.min(state.counter + 1, CONFIG.ACTIVATION_FRAMES + 1);
        } else {
            state.counter = Math.max(state.counter - 1, 0);
        }
        state.active = state.counter >= CONFIG.ACTIVATION_FRAMES;
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
}

// ------------------------------
// Drawing landmarks
// ------------------------------
function drawLandmarks(results) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = CONFIG.LANDMARK_COLOR;
    ctx.fillStyle = CONFIG.LANDMARK_COLOR;
    ctx.lineWidth = CONFIG.LINE_WIDTH;

    if (results.handLandmarks) {
        for (const landmarks of results.handLandmarks) {
            const connections = [
                [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
                [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
                [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]
            ];
            ctx.beginPath();
            for (const [i, j] of connections) {
                const p1 = landmarks[i];
                const p2 = landmarks[j];
                ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
                ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
            }
            ctx.stroke();
            for (const lm of landmarks) {
                ctx.beginPath();
                ctx.arc(lm.x * canvas.width, lm.y * canvas.height, CONFIG.DOT_RADIUS, 0, 2*Math.PI);
                ctx.fill();
            }
        }
    }

    if (results.faceLandmarks) {
        for (const landmarks of results.faceLandmarks) {
            ctx.fillStyle = CONFIG.LANDMARK_COLOR;
            for (const lm of landmarks) {
                ctx.beginPath();
                ctx.arc(lm.x * canvas.width, lm.y * canvas.height, CONFIG.DOT_RADIUS * 0.8, 0, 2*Math.PI);
                ctx.fill();
            }
        }
    }

    if (results.poseLandmarks) {
        const posePoints = [11, 12, 23, 24];
        ctx.fillStyle = CONFIG.LANDMARK_COLOR;
        for (const idx of posePoints) {
            const lm = results.poseLandmarks[idx];
            ctx.beginPath();
            ctx.arc(lm.x * canvas.width, lm.y * canvas.height, CONFIG.DOT_RADIUS, 0, 2*Math.PI);
            ctx.fill();
        }
    }
}

// ------------------------------
// Update UI overlay & debug
// ------------------------------
function updateUI() {
    if (currentMemeId) {
        overlayDiv.classList.remove('hidden');
        memeImg.src = MEME_PATHS[currentMemeId];
        captionDiv.textContent = `Meme ${currentMemeId}`;
        container.classList.add('meme-active');
        statusDiv.textContent = `Gesture ${currentMemeId} active`;
    } else {
        overlayDiv.classList.add('hidden');
        container.classList.remove('meme-active');
        let statusMsg = 'Ready';
        // Show partial progress if any condition met
        for (let id=1; id<=5; id++) {
            if (states[id].counter > 0) {
                statusMsg = `Detecting gesture ${id}...`;
                break;
            }
        }
        statusDiv.textContent = statusMsg;
    }

    // Update debug panel
    if (showDebug && lastDetectionResults) {
        let html = '';
        for (let id=1; id<=5; id++) {
            const evalRes = lastDetectionResults[id] || {};
            const active = states[id].active ? '✅' : (states[id].counter>0 ? '⏳' : '○');
            html += `<div><strong>${active} Gesture ${id}:</strong> `;
            if (id===1) html += `Idx:${evalRes.indexRaised||false} Mouth:${evalRes.mouthOpen||false} Smile:${evalRes.smile||false}`;
            else if (id===2) html += `Touch:${evalRes.touching||false} EyesUp:${evalRes.eyesUp||false} Dist:${evalRes.touchDist||'-'}`;
            else if (id===3) html += `Hands:${evalRes.handsOver||0}/2 Mouth:${evalRes.mouthOpen||false}`;
            else if (id===4) html += `MidF:${evalRes.middleFingersRaised||0}/2 Stoic:${evalRes.mouthClosed&&evalRes.noSmile&&evalRes.eyesOpen}`;
            else if (id===5) html += `Point:${evalRes.pointing||false} Wink:${evalRes.wink||false}`;
            html += '</div>';
        }
        gestureStatusDiv.innerHTML = html;
    }
}

// ------------------------------
// Process frame
// ------------------------------
async function processFrame() {
    if (!isRunning || !video.videoWidth) {
        requestAnimationFrame(processFrame);
        return;
    }

    const startTime = performance.now();
    let handResult, faceResult, poseResult;
    try {
        handResult = handLandmarker.detectForVideo(video, startTime);
        faceResult = faceLandmarker.detectForVideo(video, startTime);
        poseResult = poseLandmarker.detectForVideo(video, startTime);
    } catch (e) {
        console.warn('Detection error:', e);
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
    lastDetectionResults = evals;

    updateDebounceAndTrigger(evals, performance.now());

    if (!currentMemeId) {
        drawLandmarks({
            handLandmarks: hands,
            faceLandmarks: faceResult.faceLandmarks,
            poseLandmarks: pose
        });
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    updateUI();
    requestAnimationFrame(processFrame);
}

// ------------------------------
// Initialize camera & models
// ------------------------------
async function startCamera() {
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'user' }
        });
        video.srcObject = stream;
        await video.play();
        
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        statusDiv.textContent = 'Loading models...';
        
        // Initialize MediaPipe
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
        statusDiv.textContent = 'Ready';
        startBtn.textContent = 'Restart Camera';
        processFrame();
    } catch (err) {
        statusDiv.textContent = 'Camera error: ' + err.message;
        console.error(err);
    }
}

// ------------------------------
// Setup UI and event listeners
// ------------------------------
function initUI() {
    video = document.getElementById('video');
    canvas = document.getElementById('landmark-canvas');
    ctx = canvas.getContext('2d');
    overlayDiv = document.getElementById('meme-overlay');
    memeImg = document.getElementById('meme-image');
    captionDiv = document.getElementById('meme-caption');
    statusDiv = document.getElementById('status');
    container = document.getElementById('container');
    
    startBtn = document.getElementById('start-btn');
    debugBtn = document.getElementById('debug-btn');
    debugPanel = document.getElementById('debug-panel');
    gestureStatusDiv = document.getElementById('gesture-status');
    
    mouthSlider = document.getElementById('mouth-slider');
    smileSlider = document.getElementById('smile-slider');
    touchSlider = document.getElementById('touch-slider');
    mouthVal = document.getElementById('mouth-val');
    smileVal = document.getElementById('smile-val');
    touchVal = document.getElementById('touch-val');
    
    // Slider events
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
    
    // Buttons
    startBtn.addEventListener('click', startCamera);
    debugBtn.addEventListener('click', () => {
        showDebug = !showDebug;
        debugPanel.classList.toggle('hidden', !showDebug);
        debugBtn.textContent = showDebug ? 'Hide Debug' : 'Show Debug';
        debugBtn.classList.toggle('active', showDebug);
    });
    
    // Preload images with error handling
    for (let id in MEME_PATHS) {
        const img = new Image();
        img.onerror = () => console.warn(`Failed to load ${MEME_PATHS[id]}`);
        img.src = MEME_PATHS[id];
    }
    
    // Start camera automatically if possible
    startCamera().catch(() => {
        statusDiv.textContent = 'Click "Start Camera"';
    });
}

// Start everything
window.addEventListener('load', initUI);