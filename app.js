// MediaPipe Vision Tasks
let FaceLandmarker, HandLandmarker, FilesetResolver, DrawingUtils;

// Application State
const state = {
    camera: false,
    tracking: false,
    faceLandmarker: null,
    handLandmarker: null,
    webcamRunning: false,
    lastDetectionTime: 0,
    cooldownPeriod: 2000, // 2 seconds cooldown
    currentMeme: null,
    animationFrame: null
};

// DOM Elements
const elements = {
    webcam: document.getElementById('webcam'),
    canvas: document.getElementById('canvas'),
    memeOverlay: document.getElementById('memeOverlay'),
    memeImage: document.getElementById('memeImage'),
    toggleCamera: document.getElementById('toggleCamera'),
    toggleTracking: document.getElementById('toggleTracking'),
    statusText: document.getElementById('statusText'),
    debugInfo: document.getElementById('debugInfo'),
    handStatus: document.getElementById('handStatus'),
    faceStatus: document.getElementById('faceStatus'),
    testButtons: document.querySelectorAll('.btn.test')
};

// Canvas Context
let canvasCtx = null;
let drawingUtils = null;

// Load MediaPipe Libraries
async function loadMediaPipeLibraries() {
    try {
        const vision = await (await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.js')).default;
        FaceLandmarker = vision.FaceLandmarker;
        HandLandmarker = vision.HandLandmarker;
        FilesetResolver = vision.FilesetResolver;
        DrawingUtils = vision.DrawingUtils;
        return true;
    } catch (error) {
        console.error('Failed to load MediaPipe libraries:', error);
        updateStatus('Error loading MediaPipe libraries');
        return false;
    }
}

// Initialize MediaPipe
async function initializeMediaPipe() {
    try {
        updateStatus('Loading AI models...');
        
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );

        // Initialize Face Landmarker
        state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
                delegate: "GPU"
            },
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: false,
            runningMode: 'VIDEO',
            numFaces: 1
        });

        // Initialize Hand Landmarker
        state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
                delegate: "GPU"
            },
            runningMode: 'VIDEO',
            numHands: 2
        });

        updateStatus('Ready to start');
        if (elements.toggleCamera) {
            elements.toggleCamera.disabled = false;
        }
        
    } catch (error) {
        console.error('MediaPipe initialization error:', error);
        updateStatus('Error loading models');
    }
}

// Camera Control
async function toggleCamera() {
    if (!state.camera) {
        await startCamera();
    } else {
        stopCamera();
    }
}

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            }
        });

        if (!elements.webcam) {
            updateStatus('Webcam element not found');
            return;
        }

        elements.webcam.srcObject = stream;
        elements.webcam.classList.add('active');
        
        await new Promise((resolve) => {
            elements.webcam.onloadedmetadata = () => {
                resolve();
            };
        });

        // Setup canvas
        if (!elements.canvas) {
            updateStatus('Canvas element not found');
            return;
        }

        canvasCtx = elements.canvas.getContext('2d');
        drawingUtils = new DrawingUtils(canvasCtx);
        elements.canvas.width = elements.webcam.videoWidth;
        elements.canvas.height = elements.webcam.videoHeight;

        state.camera = true;
        state.webcamRunning = true;
        
        if (elements.toggleCamera) {
            elements.toggleCamera.textContent = 'Stop Camera';
        }
        if (elements.toggleTracking) {
            elements.toggleTracking.disabled = false;
        }
        
        updateStatus('Camera active');

        // Start detection loop
        detectGestures();

    } catch (error) {
        console.error('Camera access error:', error);
        updateStatus('Camera access denied');
    }
}

function stopCamera() {
    if (elements.webcam && elements.webcam.srcObject) {
        elements.webcam.srcObject.getTracks().forEach(track => track.stop());
    }
    
    if (elements.webcam) {
        elements.webcam.classList.remove('active');
    }
    if (elements.canvas) {
        elements.canvas.classList.remove('visible');
    }
    
    if (state.animationFrame) {
        cancelAnimationFrame(state.animationFrame);
    }

    state.camera = false;
    state.webcamRunning = false;
    state.tracking = false;
    
    if (elements.toggleCamera) {
        elements.toggleCamera.textContent = 'Start Camera';
    }
    if (elements.toggleTracking) {
        elements.toggleTracking.disabled = true;
        elements.toggleTracking.textContent = 'Show Tracking';
    }
    
    updateStatus('Camera off');
}

// Toggle Tracking Visualization
function toggleTracking() {
    state.tracking = !state.tracking;
    
    if (state.tracking) {
        if (elements.canvas) {
            elements.canvas.classList.add('visible');
        }
        if (elements.toggleTracking) {
            elements.toggleTracking.textContent = 'Hide Tracking';
        }
        if (elements.debugInfo) {
            elements.debugInfo.classList.add('active');
        }
    } else {
        if (elements.canvas) {
            elements.canvas.classList.remove('visible');
        }
        if (elements.toggleTracking) {
            elements.toggleTracking.textContent = 'Show Tracking';
        }
        if (elements.debugInfo) {
            elements.debugInfo.classList.remove('active');
        }
    }
}

// Main Detection Loop
function detectGestures() {
    if (!state.webcamRunning) return;

    const nowInMs = Date.now();
    
    // Validate models are loaded
    if (!state.handLandmarker || !state.faceLandmarker || !elements.webcam) {
        state.animationFrame = requestAnimationFrame(detectGestures);
        return;
    }

    try {
        // Detect hands
        const handResults = state.handLandmarker.detectForVideo(elements.webcam, nowInMs);
        
        // Detect face
        const faceResults = state.faceLandmarker.detectForVideo(elements.webcam, nowInMs);

        // Clear canvas if tracking is enabled
        if (state.tracking && canvasCtx && elements.canvas && drawingUtils) {
            canvasCtx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
            canvasCtx.save();
            
                      // Draw hand landmarks
            if (handResults.landmarks) {
                for (const landmarks of handResults.landmarks) {
                    drawingUtils.drawConnectors(
                        landmarks,
                        HandLandmarker.HAND_CONNECTIONS,
                        { color: 'rgba(0, 0, 0, 0.3)', lineWidth: 1 }
                    );
                    drawingUtils.drawLandmarks(
                        landmarks,
                        { color: 'rgba(0, 0, 0, 1)', lineWidth: 2, radius: 4 }
                    );
                }
            }

            // Draw face mesh (simplified) - ENHANCED VISIBILITY
            if (faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0) {
                const faceLandmarks = faceResults.faceLandmarks[0];
                drawingUtils.drawConnectors(
                    faceLandmarks,
                    FaceLandmarker.FACE_LANDMARKS_TESSELATION,
                    { color: 'rgba(0, 0, 0, 0.6)', lineWidth: 1 }
                );
                drawingUtils.drawLandmarks(
                    faceLandmarks,
                    { color: 'rgba(0, 0, 0, 0.7)', radius: 1 }
                );
            }

            canvasCtx.restore();
        }

        // Gesture Recognition
        checkGestureCombinations(handResults, faceResults, nowInMs);
    } catch (error) {
        console.error('Error in detection loop:', error);
    }

    // Continue loop
    state.animationFrame = requestAnimationFrame(detectGestures);
}

// Gesture Recognition Logic
function checkGestureCombinations(handResults, faceResults, currentTime) {
    // Cooldown check
    if (currentTime - state.lastDetectionTime < state.cooldownPeriod) {
        return;
    }

    const handGesture = detectHandGesture(handResults);
    const faceExpression = detectFaceExpression(faceResults);

    // Update debug info
    if (state.tracking) {
        if (elements.handStatus) {
            elements.handStatus.textContent = handGesture || 'None';
        }
        if (elements.faceStatus) {
            elements.faceStatus.textContent = faceExpression || 'Neutral';
        }
    }

    // Match gesture combinations
    let triggeredMeme = null;

    // 1. Index finger up + Wide smile
    if (handGesture === 'index_up' && faceExpression === 'wide_smile') {
        triggeredMeme = './point up.webp';
    }
    // 2. Hand on chin + Eyes up
    else if (handGesture === 'chin_touch' && faceExpression === 'eyes_up') {
        triggeredMeme = './thinking monkey.webp';
    }
    // 3. Hands on chest + Gasping
    else if (handGesture === 'chest_hands' && faceExpression === 'gasping') {
        triggeredMeme = './image_745226.png';
    }
    // 4. Double middle fingers + Stoic
    else if (handGesture === 'double_middle' && faceExpression === 'stoic') {
        triggeredMeme = './image_745264.png';
    }
    // 5. Point to chin + Wink
    else if (handGesture === 'chin_point' && faceExpression === 'wink') {
        triggeredMeme = './image_745cee.png';
    }

    if (triggeredMeme) {
        showMeme(triggeredMeme);
        state.lastDetectionTime = currentTime;
    }
}

// Hand Gesture Detection
function detectHandGesture(results) {
    if (!results || !results.landmarks || results.landmarks.length === 0) {
        return null;
    }

    const hands = results.landmarks;

    // Single hand gestures
    if (hands.length === 1) {
        const hand = hands[0];
        
        // Index finger up (pointing)
        if (isFingerExtended(hand, 8) && !isFingerExtended(hand, 12) && 
            !isFingerExtended(hand, 16) && !isFingerExtended(hand, 20)) {
            return 'index_up';
        }

        // Hand touching chin (base of hand near face bottom)
        if (isTouchingChin(hand)) {
            return 'chin_touch';
        }

        // Pointing to chin
        if (isPointingToChin(hand)) {
            return 'chin_point';
        }

        // Middle finger extended
        if (isFingerExtended(hand, 12) && !isFingerExtended(hand, 8) && 
            !isFingerExtended(hand, 16) && !isFingerExtended(hand, 20)) {
            return 'middle_finger';
        }
    }

    // Two hands gestures
    if (hands.length === 2) {
        const hand1 = hands[0];
        const hand2 = hands[1];

        // Both hands on chest
        if (isHandOnChest(hand1) && isHandOnChest(hand2)) {
            return 'chest_hands';
        }

        // Double middle fingers
        if (isFingerExtended(hand1, 12) && isFingerExtended(hand2, 12) &&
            !isFingerExtended(hand1, 8) && !isFingerExtended(hand2, 8)) {
            return 'double_middle';
        }
    }

    return null;
}

// Face Expression Detection
function detectFaceExpression(results) {
    if (!results || !results.faceBlendshapes || results.faceBlendshapes.length === 0) {
        return 'neutral';
    }

    const blendshapes = results.faceBlendshapes[0].categories;
    const blendshapeMap = {};
    blendshapes.forEach(shape => {
        blendshapeMap[shape.categoryName] = shape.score;
    });

    // Wide smile (mouth open + smile)
    const jawOpen = blendshapeMap['jawOpen'] || 0;
    const mouthSmile = (blendshapeMap['mouthSmileLeft'] || 0) + (blendshapeMap['mouthSmileRight'] || 0);
    
    if (jawOpen > 0.3 && mouthSmile > 0.5) {
        return 'wide_smile';
    }

    // Gasping (mouth wide open in shock)
    if (jawOpen > 0.5) {
        return 'gasping';
    }

    // Eyes looking up
    const eyeLookUp = (blendshapeMap['eyeLookUpLeft'] || 0) + (blendshapeMap['eyeLookUpRight'] || 0);
    if (eyeLookUp > 0.6) {
        return 'eyes_up';
    }

    // Winking
    const eyeBlinkLeft = blendshapeMap['eyeBlinkLeft'] || 0;
    const eyeBlinkRight = blendshapeMap['eyeBlinkRight'] || 0;
    
    if ((eyeBlinkLeft > 0.7 && eyeBlinkRight < 0.3) || 
        (eyeBlinkRight > 0.7 && eyeBlinkLeft < 0.3)) {
        return 'wink';
    }

    // Stoic (minimal expression)
    const expressiveness = jawOpen + mouthSmile + eyeLookUp;
    if (expressiveness < 0.2) {
        return 'stoic';
    }

    return 'neutral';
}

// Helper Functions for Hand Detection
function isFingerExtended(hand, tipIndex) {
    if (!hand || !hand[tipIndex] || !hand[tipIndex - 2]) {
        return false;
    }
    const tip = hand[tipIndex];
    const pip = hand[tipIndex - 2];
    return tip.y < pip.y; // Finger tip is above PIP joint
}

function isTouchingChin(hand) {
    if (!hand || !hand[0]) return false;
    const wrist = hand[0];
    // Check if wrist is in lower-center area (chin region)
    return wrist.y > 0.6 && wrist.x > 0.3 && wrist.x < 0.7;
}

function isPointingToChin(hand) {
    if (!hand || !hand[8]) return false;
    const indexTip = hand[8];
    // Index tip in chin area
    return indexTip.y > 0.65 && indexTip.x > 0.35 && indexTip.x < 0.65;
}

function isHandOnChest(hand) {
    if (!hand || !hand[0]) return false;
    const wrist = hand[0];
    // Wrist in chest area (middle-lower screen)
    return wrist.y > 0.5 && wrist.y < 0.8;
}

// Meme Display
function showMeme(imagePath) {
    if (!elements.memeImage || !elements.memeOverlay) return;
    
    if (state.currentMeme === imagePath) return; // Already showing this meme

    state.currentMeme = imagePath;
    elements.memeImage.src = imagePath;
    elements.memeOverlay.classList.remove('hidden');
    
    // Trigger animation
    setTimeout(() => {
        if (elements.memeOverlay) {
            elements.memeOverlay.classList.add('active');
        }
    }, 10);

    // Auto-hide after 3 seconds
    setTimeout(() => {
        hideMeme();
    }, 3000);
}

function hideMeme() {
    if (!elements.memeOverlay) return;
    
    elements.memeOverlay.classList.remove('active');
    setTimeout(() => {
        if (elements.memeOverlay) {
            elements.memeOverlay.classList.add('hidden');
        }
        state.currentMeme = null;
    }, 300);
}

// UI Updates
function updateStatus(message) {
    if (elements.statusText) {
        elements.statusText.textContent = message;
    }
}

// Event Listeners
if (elements.toggleCamera) {
    elements.toggleCamera.addEventListener('click', toggleCamera);
}
if (elements.toggleTracking) {
    elements.toggleTracking.addEventListener('click', toggleTracking);
}
if (elements.memeOverlay) {
    elements.memeOverlay.addEventListener('click', hideMeme);
}

// Test buttons
if (elements.testButtons && elements.testButtons.length > 0) {
    elements.testButtons.forEach(button => {
        button.addEventListener('click', () => {
            const memePath = button.getAttribute('data-meme');
            showMeme(memePath);
            state.lastDetectionTime = Date.now(); // Reset cooldown
        });
    });
}

// Initialize on load
window.addEventListener('load', async () => {
    await loadMediaPipeLibraries();
    await initializeMediaPipe();
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
    stopCamera();
});
