import { useEffect, useRef, useState } from "react";

function App() {
  const [command, setCommand] = useState("");
  const [response, setResponse] = useState("System gotowy.");
  const [route, setRoute] = useState("-");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [apiWaitSeconds, setApiWaitSeconds] = useState(0);
  const [apiStatus, setApiStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [audioInputs, setAudioInputs] = useState([]);
  const [selectedAudioInput, setSelectedAudioInput] = useState(localStorage.getItem("reze-audio-input") || "default");
  const [speakResponses, setSpeakResponses] = useState(true);
  const [ttsEngine, setTtsEngine] = useState(() => {
    if (localStorage.getItem("reze-fast-tts-migrated-v1") !== "true") {
      localStorage.setItem("reze-fast-tts-migrated-v1", "true");
      localStorage.setItem("reze-tts-engine", "fast");
      return "fast";
    }
    return localStorage.getItem("reze-tts-engine") || "fast";
  });
  const [ttsStatus, setTtsStatus] = useState({ installed: false, referenceReady: false, running: false });
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsExaggeration, setTtsExaggeration] = useState(Number(localStorage.getItem("reze-tts-exaggeration") || "0.45"));
  const [ttsCfgWeight, setTtsCfgWeight] = useState(Number(localStorage.getItem("reze-tts-cfg") || "0.0"));
  const [wakeEnabled, setWakeEnabled] = useState(localStorage.getItem("reze-wake-enabled") === "true");
  const [wakeStatus, setWakeStatus] = useState("");
  const [wakePhase, setWakePhase] = useState("off");
  const [wakeEngine, setWakeEngine] = useState({ ready: false, score: 0, threshold: 0.50, model: "reze.onnx" });
  const [wakeTemplates, setWakeTemplates] = useState(() => {
    try { return JSON.parse(localStorage.getItem("reze-wake-templates") || "[]"); } catch { return []; }
  });
  const [wakeTraining, setWakeTraining] = useState(false);
  const [wakeSensitivity, setWakeSensitivity] = useState(() => {
    const saved = Number(localStorage.getItem("reze-wake-sensitivity") || "0.80");
    // v5 forced 0.94–0.96, which is unrealistically strict for this lightweight
    // spectral-template matcher. Migrate those old values automatically.
    return saved > 0.93 ? 0.80 : Math.min(0.92, Math.max(0.68, saved || 0.80));
  });
  const [google, setGoogle] = useState({ configured: false, connected: false });
  const [googleBusy, setGoogleBusy] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [localAi, setLocalAi] = useState({ available: false, installed: false, model: "sprawdzam...", mode: "auto" });
  const [brainStatus, setBrainStatus] = useState("");
  const [browserSettings, setBrowserSettings] = useState({ selectedBrowser: "auto", browsers: [], activeBrowser: null, persistentSession: true });
  const [browserBusy, setBrowserBusy] = useState(false);

  const inputRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const audioAnimationRef = useRef(null);
  const voiceSignalRef = useRef({ speakingFrames: 0, maxRms: 0 });
  const wakeStreamRef = useRef(null);
  const wakeAudioContextRef = useRef(null);
  const wakeAnimationRef = useRef(null);
  const wakeOwwProcessorRef = useRef(null);
  const wakeOwwSourceRef = useRef(null);
  const wakeOwwZeroRef = useRef(null);
  const wakeRecorderRef = useRef(null);
  const wakeChunksRef = useRef([]);
  const geminiProcessorRef = useRef(null);
  const geminiSourceRef = useRef(null);
  const geminiActiveRef = useRef(false);
  const wakeSpeechRef = useRef({ active: false, aboveFrames: 0, silenceSince: 0 });
  const wakePausedRef = useRef(false);
  const wakeFeatureBufferRef = useRef([]);
  const wakeCandidateRef = useRef({ active: false, frames: [], startedAt: 0, silenceSince: 0, peakRms: 0, lastVoiceAt: 0 });
  const wakeNoiseFloorRef = useRef(0.004);
  const wakeTrainingRef = useRef({ active: false, frames: [], speech: false, silenceSince: 0 });
  const wakeCommandRef = useRef({ armed: false, speechSeen: false, silenceSince: 0, armedAt: 0 });
  const wakeSensitivityRef = useRef(wakeSensitivity);
  const wakeTemplatesRef = useRef(wakeTemplates);
  const wakeEnabledRef = useRef(wakeEnabled);
  const busyRef = useRef(busy);
  const ttsAudioRef = useRef(null);

  function stopSpeaking() {
    try { window.speechSynthesis?.cancel(); } catch {}
    try {
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current.currentTime = 0;
        ttsAudioRef.current = null;
      }
    } catch {}
    wakePausedRef.current = false;
  }

  function speakSystem(text) {
    if (!window.speechSynthesis || !text) return Promise.resolve();
    return new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 900));
      utterance.lang = "pl-PL";
      utterance.rate = ttsEngine === "fast" ? 1.08 : 1.0;
      utterance.pitch = 1.0;
      const voices = window.speechSynthesis.getVoices();
      const polishVoices = voices.filter((voice) => voice.lang?.toLowerCase().startsWith("pl"));
      const preferred = polishVoices.find((voice) => /zira|paulina|microsoft|google/i.test(voice.name)) || polishVoices[0];
      if (preferred) utterance.voice = preferred;
      utterance.onend = () => {
        window.setTimeout(() => { wakePausedRef.current = false; }, 200);
        resolve();
      };
      utterance.onerror = () => {
        wakePausedRef.current = false;
        resolve();
      };
      window.speechSynthesis.speak(utterance);
    });
  }

  async function speak(text, force = false) {
    if ((!speakResponses && !force) || !text) return;
    stopSpeaking();
    wakePausedRef.current = true;

    if (ttsEngine !== "chatterbox") {
      await speakSystem(text);
      return;
    }

    if (!ttsStatus.installed || !ttsStatus.referenceReady) {
      setVoiceStatus(!ttsStatus.installed
        ? "Chatterbox nie jest zainstalowany — używam głosu systemowego."
        : "Brak próbki głosu Chatterbox — używam głosu systemowego.");
      await speakSystem(text);
      return;
    }

    setTtsBusy(true);
    setVoiceStatus("Chatterbox generuje głos REZE...");
    try {
      const result = await window.desktopAgent.synthesizeSpeech(String(text).slice(0, 900), {
        exaggeration: ttsExaggeration,
        cfgWeight: ttsCfgWeight,
      });
      if (!result?.success || !result?.audioBase64) throw new Error(result?.message || "Nie udało się wygenerować głosu.");
      const audio = new Audio(`data:${result.mimeType || "audio/wav"};base64,${result.audioBase64}`);
      ttsAudioRef.current = audio;
      audio.onended = () => {
        ttsAudioRef.current = null;
        setTtsBusy(false);
        setVoiceStatus("");
        window.setTimeout(() => { wakePausedRef.current = false; }, 300);
      };
      audio.onerror = () => {
        ttsAudioRef.current = null;
        setTtsBusy(false);
        wakePausedRef.current = false;
        setVoiceStatus("Nie udało się odtworzyć audio Chatterbox.");
      };
      await audio.play();
      const suffix = result.generationMs ? ` · ${Math.max(0.1, result.generationMs / 1000).toFixed(1)} s` : "";
      setVoiceStatus(`🔊 REZE · Chatterbox${result.device ? ` · ${result.device}` : ""}${suffix}`);
    } catch (error) {
      setTtsBusy(false);
      setVoiceStatus(`Chatterbox: ${error.message} — fallback na głos systemowy.`);
      await speakSystem(text);
    }
  }

  useEffect(() => { wakeEnabledRef.current = wakeEnabled; }, [wakeEnabled]);
  useEffect(() => { wakeSensitivityRef.current = wakeSensitivity; }, [wakeSensitivity]);
  useEffect(() => { wakeTemplatesRef.current = wakeTemplates; }, [wakeTemplates]);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => {
    if (wakeEnabled) startWakeListening();
    else stopWakeListening();
    return () => stopWakeListening();
  }, [wakeEnabled, selectedAudioInput]);

  useEffect(() => {
    if (!window.desktopAgent?.onAgentStatus) return undefined;
    const unsubscribe = window.desktopAgent.onAgentStatus((status) => {
      if (status?.type === "rate_limit_wait") {
        setApiWaitSeconds(Math.max(1, Number(status.seconds) || 1));
        setApiStatus("Osiągnięto chwilowy limit Groq. REZE automatycznie wznowi zadanie.");
      }
      if (status?.type === "rate_limit_resume") {
        setApiWaitSeconds(0);
        setApiStatus("Limit odnowiony — kontynuuję zadanie...");
        window.setTimeout(() => setApiStatus(""), 2200);
      }
      if (status?.type === "local_thinking") {
        setBrainStatus(`Lokalny ${status.model || "Qwen"} interpretuje polecenie...`);
        if (status.model) setLocalAi((current) => ({ ...current, available: true, installed: true, model: status.model }));
      }
      if (status?.type === "local_delegate") setBrainStatus("Zadanie jest bardziej złożone — przekazuję je do Groq.");
      if (status?.type === "local_error") setBrainStatus("Lokalny model nie odpowiedział — używam Groq.");
      if (status?.type === "local_unavailable") setBrainStatus("Ollama/Qwen niedostępny — używam Groq.");
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!window.desktopAgent?.onWakeWordEvent) return undefined;
    const unsubscribe = window.desktopAgent.onWakeWordEvent((event) => {
      if (event?.type === "ready") {
        setWakeEngine((current) => ({
          ...current,
          ready: true,
          threshold: Number(event.threshold ?? current.threshold ?? 0.50),
          model: event.modelName || event.model || "reze.onnx",
        }));
        if (wakeEnabledRef.current && !wakePausedRef.current) setWakeUi("waiting", 'openWakeWord czeka na „REZE”…');
      }
      if (event?.type === "score") {
        setWakeEngine((current) => ({ ...current, score: Number(event.score || 0) }));
      }
      if (event?.type === "detected") {
        if (!wakeEnabledRef.current || wakePausedRef.current || busyRef.current || geminiActiveRef.current) return;
        const score = Number(event.score || 0);
        setWakeEngine((current) => ({ ...current, score }));
        wakeCommandRef.current = { armed: true, speechSeen: false, silenceSince: 0, armedAt: performance.now() };
        setWakeUi("detected", `✓ REZE WYKRYTA przez openWakeWord (${Math.round(score * 100)}%)`);
        playWakeDing();
        window.setTimeout(() => {
          if (wakeCommandRef.current.armed) setWakeUi("listening", "Słucham polecenia…");
        }, 180);
        const stream = wakeStreamRef.current;
        if (!stream) {
          wakeCommandRef.current.armed = false;
          setWakeUi("error", "Wake word wykryty, ale brak aktywnego strumienia mikrofonu.");
          return;
        }
        beginGeminiLiveCapture(stream).catch((error) => {
          wakeCommandRef.current.armed = false;
          stopGeminiAudioCapture(false);
          setWakeUi("error", `Gemini Live: ${error.message}`);
          window.setTimeout(() => {
            wakePausedRef.current = false;
            if (wakeEnabledRef.current) setWakeUi("waiting", 'openWakeWord czeka na „REZE”…');
          }, 1400);
        });
      }
      if (event?.type === "error") {
        setWakeEngine((current) => ({ ...current, ready: false }));
        setWakeUi("error", event.message || "Błąd openWakeWord.");
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!window.desktopAgent?.onGeminiLiveEvent) return undefined;
    const unsubscribe = window.desktopAgent.onGeminiLiveEvent((event) => {
      if (event?.type === "connecting") setWakeUi("connecting", "Gemini Live — łączę…");
      if (event?.type === "ready") setWakeUi("listening", "Gemini Live — słucham polecenia…");
      if (event?.type === "interim" && event.text) setWakeUi("listening", `Gemini słyszy: „${event.text}”`);
      if (event?.type === "transcript" && event.text) {
        setCommand(event.text);
        setWakeUi("processing", `Gemini: „${event.text}”`);
      }
      if (event?.type === "processing") setWakeUi("processing", "Gemini rozumie polecenie…");
      if (event?.type === "tool") setWakeUi("executing", `Gemini → ${event.action}`);
      if (event?.type === "result") {
        stopGeminiAudioCapture(false);
        applyResult(event);
        window.setTimeout(() => {
          wakePausedRef.current = false;
          if (wakeEnabledRef.current) setWakeUi("waiting", 'openWakeWord czeka na „REZE”…');
        }, 700);
      }
      if (event?.type === "error") {
        stopGeminiAudioCapture(false);
        setWakeUi("error", event.message || "Błąd Gemini Live.");
        window.setTimeout(() => {
          wakePausedRef.current = false;
          if (wakeEnabledRef.current) setWakeUi("waiting", 'openWakeWord czeka na „REZE”…');
        }, 1400);
      }
      if (event?.type === "closed") {
        stopGeminiAudioCapture(false);
        const detail = event.reason ? ` (${event.reason})` : event.code ? ` (kod ${event.code})` : "";
        setWakeUi("error", `Gemini Live rozłączyło sesję${detail}.`);
        window.setTimeout(() => {
          wakePausedRef.current = false;
          if (wakeEnabledRef.current) setWakeUi("waiting", 'openWakeWord czeka na „REZE”…');
        }, 1400);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!window.desktopAgent?.onUiCommand) return undefined;
    const unsubscribe = window.desktopAgent.onUiCommand((event) => {
      if (event?.type === "focus_input") {
        window.setTimeout(() => inputRef.current?.focus(), 50);
      }
      if (event?.type === "toggle_voice") {
        window.setTimeout(() => toggleVoice(), 50);
      }
    });
    return unsubscribe;
  });

  useEffect(() => {
    window.desktopAgent?.getLocalAiStatus?.().then((result) => {
      if (result?.success) setLocalAi(result);
    });
    window.desktopAgent?.getTtsStatus?.().then((result) => {
      if (result?.success) setTtsStatus(result);
    });
    window.desktopAgent?.getGoogleStatus?.().then((result) => {
      if (result?.success) setGoogle(result);
    });
    window.desktopAgent?.getAutostart?.().then((result) => {
      if (result?.success) setAutostart(Boolean(result.enabled));
    });
    window.desktopAgent?.getBrowserSettings?.().then((result) => {
      if (result?.success) setBrowserSettings(result);
    });
  }, []);

  useEffect(() => {
    if (!window.desktopAgent?.getLocalAiStatus) return undefined;
    const refresh = () => window.desktopAgent.getLocalAiStatus().then((result) => {
      if (result?.success) setLocalAi(result);
    }).catch(() => {});
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (apiWaitSeconds <= 0) return undefined;
    const timer = window.setInterval(() => {
      setApiWaitSeconds((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [apiWaitSeconds > 0]);

  useEffect(() => {
    refreshAudioInputs(false);
    const handler = () => refreshAudioInputs(false);
    navigator.mediaDevices?.addEventListener?.("devicechange", handler);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", handler);
  }, []);

  useEffect(() => () => {
    try { recorderRef.current?.stop(); } catch {}
    for (const track of streamRef.current?.getTracks?.() || []) track.stop();
    stopAudioAnalysis();
    stopWakeListening();
  }, []);

  async function refreshAudioInputs(requestPermission = false) {
    try {
      let tempStream = null;
      if (requestPermission) {
        tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === "audioinput");
      setAudioInputs(inputs);
      if (tempStream) tempStream.getTracks().forEach((track) => track.stop());
      if (inputs.length && selectedAudioInput !== "default" && !inputs.some((device) => device.deviceId === selectedAudioInput)) {
        setSelectedAudioInput("default");
        localStorage.setItem("reze-audio-input", "default");
      }
    } catch (error) {
      setVoiceStatus(`Nie udało się pobrać listy mikrofonów: ${error.message}`);
    }
  }

  function stopAudioAnalysis() {
    if (audioAnimationRef.current) cancelAnimationFrame(audioAnimationRef.current);
    audioAnimationRef.current = null;
    try { audioContextRef.current?.close(); } catch {}
    audioContextRef.current = null;
    analyserRef.current = null;
  }

  function startAudioAnalysis(stream) {
    stopAudioAnalysis();
    voiceSignalRef.current = { speakingFrames: 0, maxRms: 0 };
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    const data = new Float32Array(analyser.fftSize);
    const sample = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const value of data) sum += value * value;
      const rms = Math.sqrt(sum / data.length);
      voiceSignalRef.current.maxRms = Math.max(voiceSignalRef.current.maxRms, rms);
      if (rms >= 0.012) voiceSignalRef.current.speakingFrames += 1;
      audioAnimationRef.current = requestAnimationFrame(sample);
    };
    sample();
  }

  function applyResult(result, shouldSpeak = true) {
    const message = result?.message || "Gotowe.";
    setResponse(message);
    setRoute(result?.route || "-");
    if (result?.requiresConfirmation) {
      setConfirmation({ id: result.confirmationId, text: result.confirmation || message });
    } else {
      setConfirmation(null);
    }
    if (shouldSpeak && !result?.requiresConfirmation) speak(message);
  }

  function normalizeVoiceCommand(text) {
    return String(text || "")
      .trim()
      .replace(/^[\s"'„”‘’]*?(?:hej\s+)?reze(?:\s*[,.:;!?-]+\s*|\s+)/i, "")
      .replace(/^(?:czy\s+)?(?:możesz|mozesz)\s+(?:mi\s+)?/i, "")
      .replace(/^(?:proszę|prosze)\s+(?:cię|cie)?\s*/i, "")
      .replace(/^(?:weź|wez)\s+(?:mi\s+)?/i, "")
      .trim();
  }

  function isDirectMusicCommand(text) {
    const value = normalizeVoiceCommand(text);
    return /^(?:puść|pusc|zagraj|odtwórz|odtworz)\s+.+/i.test(value)
      || /^(?:włącz|wlacz)\s+(?:piosenkę|piosenke|utwór|utwor|muzykę|muzyke|coś\s+od|cos\s+od)\s*.+/i.test(value);
  }

  async function executeCommand(text) {
    const originalText = String(text || "").trim();
    if (!originalText || busy) return;
    const musicCommand = isDirectMusicCommand(originalText);
    setBusy(true);
    setResponse(musicCommand ? "Już włączam..." : "Myślę...");
    setConfirmation(null);
    try {
      // Przy muzyce REZE najpierw odpowiada głosem, dopiero potem wykonuje akcję.
      // Dzięki temu potwierdzenie nie przychodzi kilkanaście sekund po uruchomieniu utworu.
      if (musicCommand && speakResponses) {
        await speak("Jasne, już włączam.", true);
      }
      const result = await window.desktopAgent.agentCommand(originalText);
      applyResult(result, !musicCommand);
      setCommand("");
    } catch (error) {
      setResponse(`Błąd: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCommand() {
    await executeCommand(command);
  }

  async function handleConfirmation(approved) {
    if (!confirmation || busy) return;
    setBusy(true);
    setResponse(approved ? "Wykonuję zatwierdzoną akcję..." : "Anuluję...");
    try {
      const result = await window.desktopAgent.confirmAgentAction(confirmation.id, approved);
      applyResult(result);
    } catch (error) {
      setResponse(`Błąd: ${error.message}`);
      setConfirmation(null);
    } finally {
      setBusy(false);
    }
  }

  async function clearMemory() {
    const result = await window.desktopAgent.clearAgentMemory();
    setResponse(result.message);
    setRoute("LOCAL");
    setConfirmation(null);
  }

  async function startVoice() {
    if (recording || busy) return;
    stopSpeaking();
    try {
      setVoiceStatus("Uruchamiam wybrany mikrofon...");
      const audioConstraint = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        ...(selectedAudioInput && selectedAudioInput !== "default"
          ? { deviceId: { exact: selectedAudioInput } }
          : {}),
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      streamRef.current = stream;
      await refreshAudioInputs(false);
      chunksRef.current = [];
      startAudioAnalysis(stream);
      const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferred });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        setRecording(false);
        stopAudioAnalysis();
        for (const track of stream.getTracks()) track.stop();
        const signal = voiceSignalRef.current;
        const hasSpeech = signal.speakingFrames >= 4 || signal.maxRms >= 0.025;
        if (!hasSpeech) {
          setVoiceStatus("Nie wykryłem mowy. Nagranie nie zostało wysłane do API.");
          window.setTimeout(() => setVoiceStatus(""), 3500);
          return;
        }
        setVoiceStatus("Transkrybuję głos...");
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
          const arrayBuffer = await blob.arrayBuffer();
          const result = await window.desktopAgent.transcribeAudio(arrayBuffer, blob.type);
          if (!result?.success) throw new Error(result?.message || "Nie udało się rozpoznać głosu.");
          const transcript = String(result.text || "").trim();
          if (!transcript) throw new Error("Nie rozpoznałem żadnego tekstu.");
          setCommand(transcript);
          const rawTranscript = String(result.rawText || "").trim();
          setVoiceStatus(rawTranscript && rawTranscript !== transcript
            ? `Usłyszałem: „${transcript}” (STT: „${rawTranscript}”)`
            : `Usłyszałem: „${transcript}”`);
          await executeCommand(transcript);
          window.setTimeout(() => setVoiceStatus(""), 3500);
        } catch (error) {
          setVoiceStatus(`Błąd voice: ${error.message}`);
        }
      };
      recorder.start();
      setRecording(true);
      const activeTrack = stream.getAudioTracks()[0];
      setVoiceStatus(`🎙️ Słucham przez: ${activeTrack?.label || "wybrany mikrofon"}. Kliknij ponownie, aby wysłać.`);
    } catch (error) {
      setRecording(false);
      stopAudioAnalysis();
      setVoiceStatus(`Nie mogę użyć mikrofonu: ${error.message}`);
    }
  }

  function stopVoice() {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      setVoiceStatus("Kończę nagranie...");
      recorder.stop();
    }
  }

  function toggleVoice() {
    if (recording) stopVoice();
    else startVoice();
  }

  function changeAudioInput(deviceId) {
    setSelectedAudioInput(deviceId);
    localStorage.setItem("reze-audio-input", deviceId);
    const selected = audioInputs.find((device) => device.deviceId === deviceId);
    setVoiceStatus(`Wejście audio: ${selected?.label || (deviceId === "default" ? "Domyślne urządzenie" : "wybrane urządzenie")}`);
  }

  function playWakeDing() {
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContextCtor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
      osc.onended = () => ctx.close().catch(() => {});
    } catch {}
  }

  function setWakeUi(phase, message) {
    setWakePhase(phase);
    if (message !== undefined) setWakeStatus(message);
  }

  function wakeAudioConstraint() {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(selectedAudioInput && selectedAudioInput !== "default"
        ? { deviceId: { exact: selectedAudioInput } }
        : {}),
    };
  }

  function spectralFeature(analyser, freqData) {
    analyser.getFloatFrequencyData(freqData);
    const bands = 16;
    const usable = Math.min(freqData.length, 220);
    const out = [];
    for (let b = 0; b < bands; b += 1) {
      const a = Math.floor((b / bands) * usable);
      const z = Math.max(a + 1, Math.floor(((b + 1) / bands) * usable));
      let sum = 0;
      for (let i = a; i < z; i += 1) sum += Math.max(-100, freqData[i]);
      out.push(sum / (z - a));
    }
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    const centered = out.map((v) => v - mean);
    const norm = Math.sqrt(centered.reduce((a, v) => a + v * v, 0)) || 1;
    return centered.map((v) => v / norm);
  }

  function resampleSequence(seq, length = 24) {
    if (!seq?.length) return [];
    if (seq.length === 1) return Array.from({ length }, () => seq[0]);
    const out = [];
    for (let i = 0; i < length; i += 1) {
      const pos = (i / Math.max(1, length - 1)) * (seq.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(seq.length - 1, lo + 1);
      const t = pos - lo;
      out.push(seq[lo].map((v, j) => v * (1 - t) + seq[hi][j] * t));
    }
    return out;
  }

  function sequenceSimilarity(a, b) {
    if (!a?.length || !b?.length) return 0;
    const aa = resampleSequence(a, 24);
    const bb = resampleSequence(b, 24);
    let staticTotal = 0;
    let deltaTotal = 0;
    for (let i = 0; i < 24; i += 1) {
      let dot = 0, na = 0, nb = 0;
      for (let j = 0; j < aa[i].length; j += 1) {
        dot += aa[i][j] * bb[i][j];
        na += aa[i][j] * aa[i][j];
        nb += bb[i][j] * bb[i][j];
      }
      staticTotal += dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);

      if (i > 0) {
        let ddot = 0, dna = 0, dnb = 0;
        for (let j = 0; j < aa[i].length; j += 1) {
          const da = aa[i][j] - aa[i - 1][j];
          const db = bb[i][j] - bb[i - 1][j];
          ddot += da * db;
          dna += da * da;
          dnb += db * db;
        }
        deltaTotal += ddot / ((Math.sqrt(dna) * Math.sqrt(dnb)) || 1);
      }
    }
    // Same spectral envelope alone is too easy to match for unrelated words.
    // Temporal spectral movement (delta) makes this much closer to a spoken-word template.
    return (staticTotal / 24) * 0.58 + (deltaTotal / 23) * 0.42;
  }

  function calibratedWakeThreshold() {
    const templates = wakeTemplatesRef.current;
    const requested = Math.min(0.92, Math.max(0.68, wakeSensitivityRef.current || 0.80));
    if (templates.length < 3) return requested;

    // Estimate how similar the user's own REZE samples are to each other.
    // Requiring 94–96% was effectively impossible with real microphone variation.
    const pairScores = [];
    for (let i = 0; i < templates.length; i += 1) {
      for (let j = i + 1; j < templates.length; j += 1) {
        pairScores.push(sequenceSimilarity(templates[i].frames, templates[j].frames));
      }
    }
    if (!pairScores.length) return requested;
    pairScores.sort((a, b) => b - a);
    const representative = pairScores.slice(0, Math.min(5, pairScores.length))
      .reduce((sum, value) => sum + value, 0) / Math.min(5, pairScores.length);

    // Keep a real rejection margin, but never demand more consistency from a live
    // utterance than the training samples achieve among themselves.
    const learned = Math.min(0.88, Math.max(0.68, representative * 0.86));
    return Math.min(requested, learned);
  }

  function bestWakeSimilarity(buffer) {
    const templates = wakeTemplatesRef.current;
    if (templates.length < 3 || buffer.length < 8) return { score: 0, best: 0, matches: 0, durationOk: false };

    const scored = [];
    for (const template of templates) {
      const expected = Math.max(8, Number(template.rawLength) || 18);
      const ratio = buffer.length / expected;
      // A wake word is a short complete utterance. Reject phrases much shorter/longer
      // instead of matching only a convenient prefix of arbitrary speech.
      if (ratio < 0.58 || ratio > 1.55) continue;
      const similarity = sequenceSimilarity(buffer, template.frames);
      const durationPenalty = Math.max(0, 1 - Math.abs(1 - ratio) * 0.45);
      scored.push(similarity * durationPenalty);
    }
    if (scored.length < 3) return { score: 0, best: scored[0] || 0, matches: scored.length, durationOk: false };

    scored.sort((a, b) => b - a);
    const top = scored.slice(0, 3);
    const average = top.reduce((sum, value) => sum + value, 0) / top.length;
    const floor = Math.min(...top);
    return { score: average * 0.68 + floor * 0.32, best: scored[0], matches: 3, durationOk: true };
  }

  function saveWakeTemplate(frames) {
    const clean = frames.slice();
    if (clean.length < 8) {
      setWakeUi("error", "Próbka była za krótka. Powiedz wyraźnie „REZE”.");
      return;
    }
    const next = [...wakeTemplatesRef.current, { frames: resampleSequence(clean, 24), rawLength: clean.length }].slice(-5);
    wakeTemplatesRef.current = next;
    setWakeTemplates(next);
    localStorage.setItem("reze-wake-templates", JSON.stringify(next));
    setWakeUi("waiting", `Zapisano próbkę ${next.length}/5. ${next.length < 3 ? "Nagraj jeszcze kilka razy „REZE”." : "Detektor jest gotowy — używa zgodności minimum 3 wzorców."}`);
  }

  function clearWakeTemplates() {
    setWakeTemplates([]);
    wakeTemplatesRef.current = [];
    localStorage.removeItem("reze-wake-templates");
    setWakeUi("setup", "Usunięto wzorce wake wordu. Nagraj „REZE” ponownie.");
  }

  function trainWakeWord() {
    if (wakeTraining) return;
    wakeTrainingRef.current = { active: true, frames: [], speech: false, silenceSince: 0 };
    setWakeTraining(true);
    setWakeUi("training", 'Nagrywanie wzorca — powiedz tylko „REZE”…');
    if (!wakeEnabledRef.current) {
      setWakeEnabled(true);
      wakeEnabledRef.current = true;
      localStorage.setItem("reze-wake-enabled", "true");
    }
  }

  function stopWakeListening() {
    stopGeminiAudioCapture(false);
    window.desktopAgent?.geminiLiveStop?.().catch?.(() => {});
    window.desktopAgent?.wakeWordStop?.().catch?.(() => {});
    if (wakeAnimationRef.current) cancelAnimationFrame(wakeAnimationRef.current);
    wakeAnimationRef.current = null;
    try { wakeOwwProcessorRef.current?.disconnect(); } catch {}
    try { wakeOwwSourceRef.current?.disconnect(); } catch {}
    try { wakeOwwZeroRef.current?.disconnect(); } catch {}
    wakeOwwProcessorRef.current = null;
    wakeOwwSourceRef.current = null;
    wakeOwwZeroRef.current = null;
    try { wakeAudioContextRef.current?.close(); } catch {}
    wakeAudioContextRef.current = null;
    for (const track of wakeStreamRef.current?.getTracks?.() || []) track.stop();
    wakeStreamRef.current = null;
    wakeNoiseFloorRef.current = 0.004;
    wakeCommandRef.current = { armed: false, speechSeen: false, silenceSince: 0, armedAt: 0 };
    setWakeEngine((current) => ({ ...current, ready: false, score: 0 }));
    if (!wakeEnabledRef.current) setWakeUi("off", "");
  }

  function floatTo16kPcm(input, inputRate) {
    if (!input?.length) return new ArrayBuffer(0);
    const ratio = inputRate / 16000;
    const outLength = Math.max(1, Math.floor(input.length / ratio));
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const from = Math.floor(i * ratio);
      const to = Math.min(input.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = from; j < to; j += 1) sum += input[j];
      const sample = Math.max(-1, Math.min(1, sum / Math.max(1, to - from)));
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return out.buffer;
  }

  function stopGeminiAudioCapture(signalEnd = true) {
    const processor = geminiProcessorRef.current;
    geminiProcessorRef.current = null;
    try { processor?.disconnect(); } catch {}
    try { geminiSourceRef.current?.disconnect(); } catch {}
    geminiSourceRef.current = null;
    const wasActive = geminiActiveRef.current;
    geminiActiveRef.current = false;
    if (signalEnd && wasActive) window.desktopAgent?.geminiLiveEndAudio?.().catch?.(() => {});
  }

  async function beginGeminiLiveCapture(stream) {
    if (geminiActiveRef.current) return;
    wakePausedRef.current = true;
    geminiActiveRef.current = true;
    setWakeUi("connecting", "Gemini Live — łączę…");

    const ctx = wakeAudioContextRef.current;
    if (!ctx) throw new Error("Brak aktywnego AudioContext dla Gemini Live.");
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is intentionally used here for broad Electron compatibility.
    // It gives us raw float PCM which is resampled to Gemini's required 16 kHz PCM16.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    geminiSourceRef.current = source;
    geminiProcessorRef.current = processor;
    processor.onaudioprocess = (event) => {
      if (!geminiActiveRef.current) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = floatTo16kPcm(input, ctx.sampleRate);
      if (pcm.byteLength) window.desktopAgent?.geminiLiveAudio?.(pcm);
    };
    source.connect(processor);
    // ScriptProcessor needs an output connection to keep firing; zero gain prevents echo.
    const zero = ctx.createGain();
    zero.gain.value = 0;
    processor.connect(zero);
    zero.connect(ctx.destination);

    const started = await window.desktopAgent.geminiLiveStart();
    if (!started?.success) {
      stopGeminiAudioCapture(false);
      throw new Error(started?.message || "Nie udało się uruchomić Gemini Live.");
    }
  }

  async function startWakeListening() {
    stopWakeListening();
    if (!wakeEnabledRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: wakeAudioConstraint() });
      if (!wakeEnabledRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      wakeStreamRef.current = stream;

      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error("Brak AudioContext.");
      const ctx = new AudioContextCtor();
      wakeAudioContextRef.current = ctx;
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch {}
      }

      // One microphone stream, two consumers:
      // 1) openWakeWord receives continuous 16 kHz PCM locally,
      // 2) after detection Gemini Live receives the command audio.
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const zero = ctx.createGain();
      zero.gain.value = 0;
      wakeOwwSourceRef.current = source;
      wakeOwwProcessorRef.current = processor;
      wakeOwwZeroRef.current = zero;

      processor.onaudioprocess = (event) => {
        if (!wakeEnabledRef.current || wakePausedRef.current || busyRef.current || recording) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = floatTo16kPcm(input, ctx.sampleRate);
        if (pcm.byteLength) window.desktopAgent?.wakeWordAudio?.(pcm);
      };
      source.connect(processor);
      processor.connect(zero);
      zero.connect(ctx.destination);

      const started = await window.desktopAgent?.wakeWordStart?.();
      if (!started?.success) {
        throw new Error(started?.message || "Nie udało się uruchomić openWakeWord.");
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser);
      const timeData = new Float32Array(analyser.fftSize);

      setWakeUi("connecting", "Uruchamiam lokalny openWakeWord…");

      const sample = () => {
        if (!wakeEnabledRef.current) return;
        analyser.getFloatTimeDomainData(timeData);
        let sum = 0;
        for (const value of timeData) sum += value * value;
        const rms = Math.sqrt(sum / timeData.length);
        const now = performance.now();

        const commandState = wakeCommandRef.current;
        if (commandState.armed) {
          const noiseFloor = wakeNoiseFloorRef.current;
          const speechThreshold = Math.max(0.008, noiseFloor * 2.0);
          const silenceThreshold = Math.max(0.006, noiseFloor * 1.45);

          if (rms >= speechThreshold) {
            commandState.speechSeen = true;
            commandState.silenceSince = 0;
          } else if (commandState.speechSeen && rms <= silenceThreshold) {
            if (!commandState.silenceSince) commandState.silenceSince = now;
            if (now - commandState.silenceSince > 750) {
              commandState.armed = false;
              setWakeUi("processing", "Gemini rozumie polecenie…");
              stopGeminiAudioCapture(true);
            }
          } else if (commandState.speechSeen) {
            if (!commandState.silenceSince) commandState.silenceSince = now;
          }

          const maxMs = commandState.speechSeen ? 9000 : 5000;
          if (commandState.armed && now - commandState.armedAt > maxMs) {
            commandState.armed = false;
            setWakeUi("processing", commandState.speechSeen
              ? "Kończę nagranie i przekazuję do Gemini…"
              : "Nie usłyszałem polecenia — kończę sesję…");
            stopGeminiAudioCapture(true);
          }

          wakeAnimationRef.current = requestAnimationFrame(sample);
          return;
        }

        // Noise floor is still useful only for deciding when the COMMAND ended.
        // It is no longer involved in wake-word recognition.
        if (!wakePausedRef.current && !busyRef.current && !recording && rms < 0.012) {
          wakeNoiseFloorRef.current = wakeNoiseFloorRef.current * 0.985 + rms * 0.015;
        }

        wakeAnimationRef.current = requestAnimationFrame(sample);
      };
      sample();
    } catch (error) {
      setWakeUi("error", `Nie mogę uruchomić openWakeWord: ${error.message}`);
      setWakeEnabled(false);
      wakeEnabledRef.current = false;
      localStorage.setItem("reze-wake-enabled", "false");
    }
  }

  function toggleWake() {
    const next = !wakeEnabled;
    setWakeEnabled(next);
    wakeEnabledRef.current = next;
    localStorage.setItem("reze-wake-enabled", String(next));
    setWakeStatus(next ? 'Uruchamiam lokalny openWakeWord…' : "Nasłuchiwanie wyłączone.");
  }

  function changeWakeSensitivity(value) {
    const next = Math.min(0.92, Math.max(0.68, Number(value)));
    setWakeSensitivity(next);
    wakeSensitivityRef.current = next;
    localStorage.setItem("reze-wake-sensitivity", String(next));
  }

  async function connectGoogle() {
    if (googleBusy) return;
    setGoogleBusy(true);
    setResponse("Otwieram logowanie Google. Zaloguj się i zaakceptuj dostęp dla REZE...");
    setRoute("GOOGLE");
    try {
      const result = await window.desktopAgent.connectGoogle();
      if (!result?.success) throw new Error(result?.message || "Nie udało się połączyć Google.");
      const status = await window.desktopAgent.getGoogleStatus();
      setGoogle(status);
      setResponse("Google połączone. REZE może teraz czytać Gmail i Kalendarz zgodnie z nadanymi uprawnieniami.");
    } catch (error) {
      setResponse(`Google: ${error.message}`);
    } finally {
      setGoogleBusy(false);
    }
  }

  async function refreshBrowserSettings() {
    const result = await window.desktopAgent.getBrowserSettings();
    if (result?.success) setBrowserSettings(result);
    return result;
  }

  async function changePreferredBrowser(value) {
    setBrowserBusy(true);
    try {
      const result = await window.desktopAgent.setPreferredBrowser(value);
      if (!result?.success) throw new Error(result?.message || "Nie udało się zmienić przeglądarki.");
      setBrowserSettings(result);
      const label = value === "auto" ? "automatyczną" : value;
      setResponse(`Domyślna przeglądarka REZE: ${label}.`);
      setRoute("LOCAL");
    } catch (error) {
      setResponse(`Przeglądarka: ${error.message}`);
    } finally {
      setBrowserBusy(false);
    }
  }

  async function openYouTubeMusicLogin() {
    setBrowserBusy(true);
    setResponse("Otwieram YouTube Music w trwałym profilu REZE...");
    try {
      const result = await window.desktopAgent.openYouTubeMusicLogin();
      if (!result?.success) throw new Error(result?.message || "Nie udało się otworzyć YouTube Music.");
      setResponse(result.message || "YouTube Music otwarty. Zaloguj się raz, jeśli trzeba.");
      await refreshBrowserSettings();
    } catch (error) {
      setResponse(`YouTube Music: ${error.message}`);
    } finally {
      setBrowserBusy(false);
    }
  }

  async function refreshTtsStatus() {
    const result = await window.desktopAgent.getTtsStatus();
    if (result?.success) setTtsStatus(result);
    return result;
  }

  async function importVoiceReference() {
    setTtsBusy(true);
    setVoiceStatus("Wybierz czystą próbkę WAV głosu...");
    try {
      const result = await window.desktopAgent.importTtsReference();
      if (result?.canceled) {
        setVoiceStatus("");
        return;
      }
      if (!result?.success) throw new Error(result?.message || "Nie udało się zaimportować próbki.");
      setTtsStatus(result);
      setTtsEngine("chatterbox");
      localStorage.setItem("reze-tts-engine", "chatterbox");
      setVoiceStatus("✓ Próbka głosu REZE gotowa. Kliknij Odsłuch.");
    } catch (error) {
      setVoiceStatus(`Błąd próbki głosu: ${error.message}`);
    } finally {
      setTtsBusy(false);
    }
  }

  function changeTtsEngine(value) {
    stopSpeaking();
    setTtsEngine(value);
    localStorage.setItem("reze-tts-engine", value);
  }

  async function previewTtsVoice() {
    await speak("Hej, jestem REZE. Miło cię słyszeć. Powiedz tylko, czego potrzebujesz, a postaram się pomóc.", true);
  }

  function changeTtsExaggeration(value) {
    const next = Number(value);
    setTtsExaggeration(next);
    localStorage.setItem("reze-tts-exaggeration", String(next));
  }

  function changeTtsCfgWeight(value) {
    const next = Number(value);
    setTtsCfgWeight(next);
    localStorage.setItem("reze-tts-cfg", String(next));
  }

  async function toggleAutostart() {
    const next = !autostart;
    const result = await window.desktopAgent.setAutostart(next);
    if (result?.success) {
      setAutostart(Boolean(result.enabled));
      setResponse(result.message);
      setRoute("LOCAL");
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Enter") handleCommand();
  }

  const buttonStyle = { padding: "11px 16px", fontSize: "14px", cursor: "pointer", background: "#18222d", color: "#e8f4ff", border: "1px solid #33495c", borderRadius: "9px" };

  return (
    <div style={{ minHeight: "100vh", background: "#0b0f14", color: "#e8f4ff", display: "flex", justifyContent: "center", alignItems: "center", fontFamily: "Arial, sans-serif" }}>
      <div style={{ width: "760px", padding: "26px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end" }}>
          <div>
            <p style={{ marginBottom: "6px", color: "#64748b" }}>DESKTOP AGENT · Ctrl+Space</p>
            <h1 style={{ marginTop: 0, marginBottom: "16px", fontSize: "42px" }}>REZE</h1>
          </div>
          <div style={{ color: "#64748b", fontSize: "13px", marginBottom: "20px", textAlign: "right" }}>
            <div>ROUTE: <span style={{ color: "#58d6ff" }}>{route}</span></div>
            <div style={{ marginTop: "5px" }}>LOCAL AI: <span style={{ color: localAi.available && localAi.installed ? "#75e6a4" : "#d8a66a" }}>{localAi.available && localAi.installed ? `✓ ${localAi.mode === "auto" ? "AUTO • " : ""}${localAi.model}` : `○ ${localAi.model}`}</span></div>
          </div>
        </div>

        <div style={{ background: "#121922", border: "1px solid #243240", borderRadius: "12px", padding: "18px", marginBottom: "14px", whiteSpace: "pre-wrap", maxHeight: "260px", overflowY: "auto" }}>
          <span style={{ color: "#58d6ff" }}>REZE:</span> {response}
        </div>

        {(voiceStatus || wakeStatus) && <div style={{ background: "#101b20", border: "1px solid #295466", borderRadius: "10px", padding: "11px 14px", marginBottom: "14px", color: "#bfeeff" }}>{voiceStatus || wakeStatus}</div>}
        {brainStatus && <div style={{ background: "#111820", border: "1px solid #2b3b4b", borderRadius: "10px", padding: "10px 14px", marginBottom: "14px", color: "#9fb5c6" }}>{brainStatus}</div>}

        {apiStatus && (
          <div style={{ background: "#141b22", border: "1px solid #365063", borderRadius: "12px", padding: "14px 16px", marginBottom: "14px", color: "#cfefff" }}>
            <div style={{ color: "#58d6ff", fontWeight: 700, marginBottom: "4px" }}>{apiWaitSeconds > 0 ? `⏳ Limit API — ponawiam za ${apiWaitSeconds} s` : "REZE"}</div>
            <div style={{ fontSize: "14px", color: "#9fb5c6" }}>{apiStatus}</div>
          </div>
        )}

        {confirmation && (
          <div style={{ background: "#171a20", border: "1px solid #665c35", borderRadius: "12px", padding: "16px", marginBottom: "14px" }}>
            <div style={{ marginBottom: "12px" }}>Wymagane potwierdzenie: {confirmation.text}</div>
            <button disabled={busy} onClick={() => handleConfirmation(true)} style={{ ...buttonStyle, marginRight: "10px" }}>Zezwól</button>
            <button disabled={busy} onClick={() => handleConfirmation(false)} style={buttonStyle}>Anuluj</button>
          </div>
        )}

        <div style={{ display: "flex", gap: "10px" }}>
          <input ref={inputRef} value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={handleKeyDown} placeholder="Wpisz polecenie..." autoFocus disabled={busy || Boolean(confirmation)} style={{ flex: 1, boxSizing: "border-box", padding: "17px", fontSize: "18px", background: "#121922", border: "1px solid #2e4356", color: "white", borderRadius: "10px", outline: "none", opacity: busy || confirmation ? 0.65 : 1 }} />
          <button disabled={busy || Boolean(confirmation)} onClick={toggleVoice} style={{ ...buttonStyle, minWidth: "122px", borderColor: recording ? "#58d6ff" : "#33495c" }}>{recording ? "⏹ Wyślij" : "🎙 Mów"}</button>
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "10px", alignItems: "center" }}>
          <span style={{ color: "#7f95a7", fontSize: "13px", minWidth: "88px" }}>Wejście audio:</span>
          <select
            value={selectedAudioInput}
            onChange={(e) => changeAudioInput(e.target.value)}
            disabled={recording}
            style={{ flex: 1, padding: "10px 12px", background: "#121922", color: "#e8f4ff", border: "1px solid #2e4356", borderRadius: "9px" }}
          >
            <option value="default">Domyślne urządzenie Windows</option>
            {audioInputs.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `Mikrofon ${index + 1}`}
              </option>
            ))}
          </select>
          <button disabled={recording} onClick={() => refreshAudioInputs(true)} style={buttonStyle}>Odśwież</button>
        </div>

        <div style={{ marginTop: "12px", padding: "14px 16px", background: "#10161d", border: "1px solid #243240", borderRadius: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 800 }}>Głos REZE</div>
              <div style={{ color: "#667b8c", fontSize: "12px", marginTop: "4px" }}>FAST = natychmiast · HQ = Chatterbox</div>
            </div>
            <div style={{ color: ttsStatus.installed ? "#75e6a4" : "#d8a66a", fontSize: "12px" }}>
              {ttsStatus.installed ? "✓ Chatterbox zainstalowany" : "○ Uruchom SETUP-CHATTERBOX.ps1"}
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", marginTop: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <select value={ttsEngine} onChange={(e) => changeTtsEngine(e.target.value)} style={{ padding: "10px 12px", background: "#121922", color: "#e8f4ff", border: "1px solid #2e4356", borderRadius: "9px" }}>
              <option value="fast">FAST · Windows TTS</option>
              <option value="system">Systemowy TTS</option>
              <option value="chatterbox">HQ · Chatterbox V3</option>
            </select>
            <button disabled={ttsBusy} onClick={importVoiceReference} style={buttonStyle}>+ Importuj WAV</button>
            <button disabled={ttsBusy || (ttsEngine === "chatterbox" && !ttsStatus.referenceReady)} onClick={previewTtsVoice} style={buttonStyle}>{ttsBusy ? "Generuję..." : "▶ Odsłuch"}</button>
            <button disabled={ttsBusy} onClick={refreshTtsStatus} style={buttonStyle}>Odśwież</button>
            <span style={{ color: ttsStatus.referenceReady ? "#75e6a4" : "#7f95a7", fontSize: "12px" }}>{ttsStatus.referenceReady ? "✓ Próbka gotowa" : "Brak próbki WAV"}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 48px", gap: "8px", alignItems: "center", marginTop: "12px" }}>
            <span style={{ color: "#7f95a7", fontSize: "12px" }}>Ekspresja</span>
            <input type="range" min="0" max="1" step="0.05" value={ttsExaggeration} onChange={(e) => changeTtsExaggeration(e.target.value)} />
            <span style={{ color: "#9fb5c6", fontSize: "12px" }}>{ttsExaggeration.toFixed(2)}</span>
            <span style={{ color: "#7f95a7", fontSize: "12px" }}>Akcent ref.</span>
            <input type="range" min="0" max="0.6" step="0.05" value={ttsCfgWeight} onChange={(e) => changeTtsCfgWeight(e.target.value)} />
            <span style={{ color: "#9fb5c6", fontSize: "12px" }}>{ttsCfgWeight.toFixed(2)}</span>
          </div>
          <div style={{ marginTop: "8px", color: "#667b8c", fontSize: "12px", lineHeight: 1.45 }}>
            Dla angielskiej próbki zostaw „Akcent ref.” blisko 0.00 — pomaga zachować polską wymowę. Najlepiej użyć 10–20 s czystej mowy bez muzyki i efektów.
          </div>
        </div>

        <div style={{ marginTop: "12px", padding: "14px 16px", background: "#10161d", border: "1px solid #243240", borderRadius: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 800 }}>Przeglądarka REZE + YouTube Music</div>
              <div style={{ color: "#667b8c", fontSize: "12px", marginTop: "4px" }}>Wybierz przeglądarkę raz. YouTube Music używa teraz Twojego normalnego profilu Brave/Chrome/Edge, więc działa istniejące logowanie Google.</div>
            </div>
            <div style={{ color: "#75e6a4", fontSize: "12px" }}>
              {browserSettings.activeBrowser ? `aktywna: ${browserSettings.activeBrowser}` : "profil trwały"}
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", marginTop: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={browserSettings.selectedBrowser || "auto"}
              onChange={(e) => changePreferredBrowser(e.target.value)}
              disabled={browserBusy}
              style={{ padding: "10px 12px", background: "#121922", color: "#e8f4ff", border: "1px solid #2e4356", borderRadius: "9px" }}
            >
              <option value="auto">Auto</option>
              {(browserSettings.browsers || []).filter((item) => item.installed).map((item) => (
                <option key={item.name} value={item.name}>{item.name === "brave" ? "Brave" : item.name === "chrome" ? "Google Chrome" : "Microsoft Edge"}</option>
              ))}
            </select>
            <button disabled={browserBusy} onClick={openYouTubeMusicLogin} style={buttonStyle}>{browserBusy ? "Otwieram..." : "♫ Otwórz / zaloguj YouTube Music"}</button>
            <button disabled={browserBusy} onClick={refreshBrowserSettings} style={buttonStyle}>Odśwież</button>
          </div>
          <div style={{ marginTop: "8px", color: "#667b8c", fontSize: "12px", lineHeight: 1.45 }}>
            Możesz powiedzieć np. „puść IRIS OUT” albo „puść coś od Ado”. Jeśli aktywne okno YouTube Music jest już otwarte, REZE przełączy utwór w nim; w przeciwnym razie użyje normalnego profilu wybranej przeglądarki.
          </div>
        </div>

        <div
          style={{
            marginTop: "12px",
            padding: "14px 16px",
            borderRadius: "12px",
            border: wakePhase === "detected" ? "2px solid #44d17a" : "1px solid #2b3947",
            background:
              wakePhase === "detected" ? "#123a22" :
              wakePhase === "listening" ? "#3a3212" :
              wakePhase === "connecting" ? "#24314a" :
              wakePhase === "processing" ? "#2b1c46" :
              wakePhase === "executing" ? "#25313d" :
              wakePhase === "error" ? "#401919" :
              wakePhase === "waiting" ? "#12283a" :
              "#171b20",
            boxShadow: wakePhase === "detected" ? "0 0 22px rgba(68,209,122,.45)" : "none",
            transition: "all .18s ease",
          }}
        >
          <div style={{ fontWeight: 800, fontSize: "15px", letterSpacing: ".4px" }}>
            {wakePhase === "detected" ? "✓ REZE WYKRYTA" :
             wakePhase === "listening" ? "🎙 SŁUCHAM POLECENIA" :
             wakePhase === "connecting" ? "◌ ŁĄCZĘ Z GEMINI LIVE" :
             wakePhase === "processing" ? "✦ GEMINI ROZUMIE" :
             wakePhase === "executing" ? "⚡ WYKONUJĘ" :
             wakePhase === "training" ? "🎙 NAGRYWAM WZORZEC" :
             wakePhase === "waiting" ? "👂 CZEKAM NA „REZE”" :
             wakePhase === "setup" ? "⚙ SKONFIGURUJ WAKE WORD" :
             wakePhase === "error" ? (String(wakeStatus || "").toLowerCase().includes("gemini") ? "⚠ BŁĄD GEMINI LIVE" : "⚠ BŁĄD WAKE WORD") :
             "REZE WAKE WORD — OFF"}
          </div>
          <div style={{ marginTop: "5px", color: "#9eb0bf", fontSize: "13px" }}>
            {wakeStatus || "Nasłuchiwanie jest wyłączone."}
          </div>
        </div>

        <div style={{ marginTop: "12px", padding: "12px", background: "#10161d", border: "1px solid #243240", borderRadius: "10px" }}>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#7f95a7", fontSize: "13px" }}>Wake engine:</span>
            <span style={{ color: wakeEngine.ready ? "#79e7a7" : "#ffb46b", fontSize: "13px", fontWeight: 700 }}>
              {wakeEngine.ready ? "openWakeWord · GOTOWY" : "openWakeWord · NIEGOTOWY"}
            </span>
            <span style={{ color: "#7f95a7", fontSize: "13px" }}>
              score {Math.round((wakeEngine.score || 0) * 100)}% · próg {Math.round((wakeEngine.threshold || 0.5) * 100)}%
            </span>
          </div>
          <div style={{ marginTop: "8px", color: "#667b8c", fontSize: "12px" }}>
            Nagraj słowo „REZE” 3–5 razy normalnym głosem. Detektor sprawdza tylko początek wypowiedzi i wymaga zgodności kilku wzorców, więc zwykła mowa nie powinna go wybudzać. Po wykryciu REZE Gemini dostaje bezpośrednio audio komendy; koniec mowy wykrywany jest lokalnie i ma dodatkowy timeout bezpieczeństwa.
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "12px", flexWrap: "wrap" }}>
          <button disabled={busy || Boolean(confirmation)} onClick={handleCommand} style={buttonStyle}>{busy ? "Pracuję..." : "Wykonaj"}</button>
          <button disabled={busy} onClick={clearMemory} style={buttonStyle}>Wyczyść pamięć</button>
          <button onClick={toggleWake} style={{ ...buttonStyle, borderColor: wakeEnabled ? "#58d6ff" : "#33495c" }}>{wakeEnabled ? "👂 REZE: ON" : "👂 REZE: OFF"}</button>
          <button onClick={() => setSpeakResponses((v) => !v)} style={buttonStyle}>{speakResponses ? "🔊 Głos: ON" : "🔇 Głos: OFF"}</button>
          <button onClick={toggleAutostart} style={buttonStyle}>{autostart ? "✓ Autostart ON" : "Autostart OFF"}</button>
          <button disabled={googleBusy} onClick={connectGoogle} style={{ ...buttonStyle, borderColor: google.connected ? "#35694a" : "#33495c" }}>{google.connected ? "✓ Google połączone" : googleBusy ? "Łączę Google..." : "Połącz Google"}</button>
        </div>

        <div style={{ marginTop: "14px", color: "#667b8c", fontSize: "12px", lineHeight: 1.5 }}>
          Mózg: naturalne polecenia trafiają najpierw do lokalnego Qwen przez Ollama; trudniejsze zadania automatycznie przechodzą do Groq. Sterowanie aplikacjami preferuje Windows UI Automation zamiast klikania po pikselach. Ctrl+Space pokazuje okno, Ctrl+Shift+Space uruchamia/zatrzymuje nagrywanie głosu.
          {!google.configured && <div style={{ color: "#a78b6d", marginTop: "4px" }}>Google: dodaj GOOGLE_CLIENT_ID (i opcjonalnie GOOGLE_CLIENT_SECRET) do .env, aby aktywować Gmail/Kalendarz.</div>}
        </div>
      </div>
    </div>
  );
}

export default App;
