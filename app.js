// ------------------------------
// Configuration (match Python thresholds)
// ------------------------------
const CONFIG = {
    LANDMARK_COLOR: '#ffffff',
    LINE_WIDTH: 1.2,
    DOT_RADIUS: 1.8,
    ACTIVATION_FRAMES: 3,
    DEACTIVATION_FRAMES: 5,
    TRIGGER_COOLDOWN: 2000, // ms

    // Thresholds (normalized coordinates)
    FINGER_EXTEND_THRESH_Y: 0.03,  // tip must be above PIP by this amount
    MOUTH_OPEN_THRESH: 0.04,
    SMILE_THRESH: 0.28,
    EYE_CLOSED_THRESH: 0.22,
    TOUCH_DIST_THRESH: 0.08,
    CHEST_PROXIMITY_THRESH: 0.15,
    EYES_UP_THRESH: 0.015,
};

// Meme images mapping (relative paths)
const MEME_PATHS = {
    1: './point up.webp',
    2: './thinking monkey.webp',
    3: './image_745226.png',
    4: './image_745264.png',
    5: './image_745cee.png'
};

// ------------------------------
// Global state
// ------------------------------
let video, canvas, ctx;
let overlayDiv, memeImg, captionDiv, statusDiv;
let faceLandmarker, handLandmarker, poseLandmarker;
let lastVideoTime = -1;
let isRunning = false;

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

// ------------------------------
// Helper: Euclidean distance (normalized)
// ------------------------------
function normalizedDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx*dx + dy*dy);
}

// ------------------------------
// Finger extended check (hand landmarks)
// ------------------------------
function isFingerExtended(landmarks, tipIdx, pipIdx) {
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    // MediaPipe y=0 at top, so extended means tip.y < pip.y
    return (pip.y - tip.y) > CONFIG.FINGER_EXTEND_THRESH_Y;
}

// ------------------------------
// Mouth openness ratio
// ------------------------------
function mouthOpenRatio(landmarks) {
    // Using indices: upper lip (13), lower lip (14), left corner (61), right corner (291)
    const upper = landmarks[13];
    const lower = landmarks[14];
    const left = landmarks[61];
    const right = landmarks[291];
    const height = Math.abs(upper.y - lower.y);
    const width = Math.abs(left.x - right.x);
    return width > 0 ? height / width : 0;
}

// ------------------------------
// Smile ratio (horizontal stretch)
// ------------------------------
function smileRatio(landmarks) {
    const left = landmarks[61];
    const right = landmarks[291];
    const center = landmarks[13];  // upper lip center approx
    const faceLeft = landmarks[234];
    const faceRight = landmarks[454];
    const faceWidth = Math.abs(faceRight.x - faceLeft.x);
    const stretch = Math.abs(left.x - center.x) + Math.abs(right.x - center.x);
    return stretch / faceWidth;
}

// ------------------------------
// Eye Aspect Ratio (EAR)
// ------------------------------
function eyeAspectRatio(landmarks, indices) {
    const v1 = landmarks[indices[1]];
    const v2 = landmarks[indices[2]];
    const h1 = landmarks[indices[0]];
    const h2 = landmarks[indices[3]];
    const vertical = Math.abs(v1.y - v2.y);
    const horizontal = Math.abs(h1.x - h2.x);
    return horizontal > 0 ? vertical / horizontal : 1;
}

// ------------------------------
// Eye gaze up (using iris landmarks)
// ------------------------------
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
// Gesture evaluators
// ------------------------------
function evaluateGesture1(hands, face, pose) {
    if (!hands.length || !face) return false;
    // Index finger raised (other fingers down simplified)
    let indexRaised = false;
    for (const hand of hands) {
        if (isFingerExtended(hand, 8, 6) && !isFingerExtended(hand, 12, 10)) {
            indexRaised = true;
            break;
        }
    }
    if (!indexRaised) return false;
    const mouthOpen = mouthOpenRatio(face) > CONFIG.MOUTH_OPEN_THRESH;
    const smile = smileRatio(face) > CONFIG.SMILE_THRESH;
    return mouthOpen && smile;
}

function evaluateGesture2(hands, face, pose) {
    if (!hands.length || !face) return false;
    const chin = face[152];
    let touching = false;
    for (const hand of hands) {
        const indexTip = hand[8];
        if (normalizedDistance(indexTip, chin) < CONFIG.TOUCH_DIST_THRESH) {
            touching = true;
            break;
        }
    }
    if (!touching) return false;
    return isGazingUp(face);
}

function evaluateGesture3(hands, face, pose) {
    if (hands.length < 2 || !face || !pose) return false;
    // Chest center from shoulders (11 left, 12 right)
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
    if (handsOver < 2) return false;
    const mouthOpen = mouthOpenRatio(face) > CONFIG.MOUTH_OPEN_THRESH * 1.3;
    return mouthOpen;
}

function evaluateGesture4(hands, face, pose) {
    if (!hands.length || !face) return false;
    let middleFingersRaised = 0;
    for (const hand of hands) {
        if (isFingerExtended(hand, 12, 10) &&
            !isFingerExtended(hand, 8, 6) &&
            !isFingerExtended(hand, 16, 14)) {
            middleFingersRaised++;
        }
    }
    if (middleFingersRaised < 2) return false;
    // Stoic: mouth closed, no smile, eyes open
    const mouthClosed = mouthOpenRatio(face) < CONFIG.MOUTH_OPEN_THRESH * 0.8;
    const noSmile = smileRatio(face) < CONFIG.SMILE_THRESH * 0.7;
    const leftEAR = eyeAspectRatio(face, [33, 159, 158, 133]);
    const rightEAR = eyeAspectRatio(face, [362, 385, 386, 263]);
    const eyesOpen = leftEAR > CONFIG.EYE_CLOSED_THRESH && rightEAR > CONFIG.EYE_CLOSED_THRESH;
    return mouthClosed && noSmile && eyesOpen;
}

function evaluateGesture5(hands, face, pose) {
    if (!hands.length || !face) return false;
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
    if (!pointing) return false;
    const leftEAR = eyeAspectRatio(face, [33, 159, 158, 133]);
    const rightEAR = eyeAspectRatio(face, [362, 385, 386, 263]);
    const leftClosed = leftEAR < CONFIG.EYE_CLOSED_THRESH;
    const rightClosed = rightEAR < CONFIG.EYE_CLOSED_THRESH;
    return (leftClosed && !rightClosed) || (rightClosed && !leftClosed);
}

// ------------------------------
// Debounce & trigger logic
// ------------------------------
function updateDebounceAndTrigger(evaluations, now) {
    let anyActive = false;
    let activeId = null;

    for (let id = 1; id <= 5; id++) {
        const state = states[id];
        if (evaluations[id]) {
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

    // Cooldown
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
// Drawing landmarks (thin white)
// ------------------------------
function drawLandmarks(results) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = CONFIG.LANDMARK_COLOR;
    ctx.fillStyle = CONFIG.LANDMARK_COLOR;
    ctx.lineWidth = CONFIG.LINE_WIDTH;

    // Draw hand landmarks with connections
    if (results.handLandmarks) {
        for (const landmarks of results.handLandmarks) {
            // Draw connections
            const connections = [
                [0,1],[1,2],[2,3],[3,4],  // thumb
                [0,5],[5,6],[6,7],[7,8],  // index
                [0,9],[9,10],[10,11],[11,12], // middle
                [0,13],[13,14],[14,15],[15,16], // ring
                [0,17],[17,18],[18,19],[19,20], // pinky
                [5,9],[9,13],[13,17]      // palm
            ];
            ctx.beginPath();
            for (const [i, j] of connections) {
                const p1 = landmarks[i];
                const p2 = landmarks[j];
                ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
                ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
            }
            ctx.stroke();

            // Draw dots
            for (const lm of landmarks) {
                ctx.beginPath();
                ctx.arc(lm.x * canvas.width, lm.y * canvas.height, CONFIG.DOT_RADIUS, 0, 2*Math.PI);
                ctx.fill();
            }
        }
    }

    // Face mesh – dots only, no connections
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

    // Pose – only shoulder/hip dots
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
// Update UI overlay
// ------------------------------
function updateOverlay() {
    const container = document.querySelector('.container');
    if (currentMemeId) {
        overlayDiv.classList.remove('hidden');
        memeImg.src = MEME_PATHS[currentMemeId];
        captionDiv.textContent = `Meme ${currentMemeId}`;
        container.classList.add('meme-active');
        statusDiv.textContent = `Gesture ${currentMemeId} active`;
    } else {
        overlayDiv.classList.add('hidden');
        container.classList.remove('meme-active');
        statusDiv.textContent = 'Ready';
    }
}

// ------------------------------
// Main processing loop
// ------------------------------
async function processFrame() {
    if (!isRunning) return;

    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;

        // Run detectors
        const startTime = performance.now();
        const handResult = handLandmarker.detectForVideo(video, startTime);
        const faceResult = faceLandmarker.detectForVideo(video, startTime);
        const poseResult = poseLandmarker.detectForVideo(video, startTime);

        // Extract data
        const hands = handResult.landmarks || [];
        const face = faceResult.faceLandmarks?.[0] || null;
        const pose = poseResult.landmarks?.[0] || null;

        // Evaluate gestures
        const evals = {
            1: evaluateGesture1(hands, face, pose),
            2: evaluateGesture2(hands, face, pose),
            3: evaluateGesture3(hands, face, pose),
            4: evaluateGesture4(hands, face, pose),
            5: evaluateGesture5(hands, face, pose)
        };

        // Update state
        updateDebounceAndTrigger(evals, performance.now());

        // Draw landmarks (only if no meme active)
        if (!currentMemeId) {
            drawLandmarks({
                handLandmarks: hands,
                faceLandmarks: faceResult.faceLandmarks,
                poseLandmarks: pose
            });
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        updateOverlay();
    }

    requestAnimationFrame(processFrame);
}

// ------------------------------
// Initialization
// ------------------------------
async function init() {
    video = document.getElementById('video');
    canvas = document.getElementById('landmark-canvas');
    ctx = canvas.getContext('2d');
    overlayDiv = document.getElementById('meme-overlay');
    memeImg = document.getElementById('meme-image');
    captionDiv = document.getElementById('meme-caption');
    statusDiv = document.getElementById('status');

    // Set up camera
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }
    });
    video.srcObject = stream;
    await video.play();

    // Wait for video metadata to set canvas size
    await new Promise(resolve => { video.onloadedmetadata = resolve; });
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Initialize MediaPipe tasks
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
        outputFacialTransformationMatrixes: false,
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
    processFrame();
    statusDiv.textContent = 'Ready';
}

// Start everything when page loads
window.addEventListener('load', init);