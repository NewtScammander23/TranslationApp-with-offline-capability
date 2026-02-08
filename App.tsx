
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry, AppMode } from './types';
import { decode, encode, decodeAudioData, createBlob } from './services/audio-helpers';
import VoiceVisualizer from './components/VoiceVisualizer';
import TranscriptionList from './components/TranscriptionList';

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 2000;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [mode, setMode] = useState<AppMode>(AppMode.TRANSLATE);
  const [history, setHistory] = useState<TranscriptionEntry[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isAwake, setIsAwake] = useState(false);
  const [volume, setVolume] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isPoliteMode, setIsPoliteMode] = useState(false);
  const [currentMood, setCurrentMood] = useState<'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'cool'>('neutral');

  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionRef = useRef<{ input: string, output: string }>({ input: '', output: '' });
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => {
      setIsOnline(false);
      stopSession();
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (retryTimeoutRef.current) window.clearTimeout(retryTimeoutRef.current);
    };
  }, []);

  const stopSession = useCallback(() => {
    if (retryTimeoutRef.current) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    
    if (sessionRef.current) {
      try {
        sessionRef.current.close();
      } catch (e) {
        console.debug('Session close error handled');
      }
      sessionRef.current = null;
    }

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();

    const closeCtx = (ctxRef: React.MutableRefObject<AudioContext | null>) => {
      if (ctxRef.current) {
        const ctx = ctxRef.current;
        if (ctx.state !== 'closed') {
          try {
            ctx.close().catch(() => {});
          } catch (e) {
            console.debug('Context close handled');
          }
        }
        ctxRef.current = null;
      }
    };

    closeCtx(inputAudioCtxRef);
    closeCtx(outputAudioCtxRef);

    setStatus(ConnectionStatus.IDLE);
    setIsSpeaking(false);
    setIsAwake(false);
    setCurrentMood('neutral');
    nextStartTimeRef.current = 0;
    retryCountRef.current = 0;
  }, []);

  const startSession = async () => {
    if (!isOnline) {
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    try {
      if (retryCountRef.current === 0) {
        setStatus(ConnectionStatus.CONNECTING);
      } else {
        setStatus(ConnectionStatus.RECONNECTING);
      }
      
      setIsAwake(false);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true, channelCount: 1 } 
      });

      const modeInstruction = mode === AppMode.TRANSLATE 
        ? "PURE TRANSLATION MODE: You are a focused English-Filipino translator. If input is English, output Filipino. If input is Filipino, output English. Output ONLY the translation. Do not provide extra conversational text or explanations."
        : "CHAT MODE: You are 'Salin', a lively and friendly bilingual companion. Engage in warm conversation using both English and Filipino. Be expressive and helpful.";

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are 'Salin'. ${modeInstruction}
          
          WAKE PHRASES: "Hey Salin", "Hoy Salin", "Kamusta Salin", "What's up Salin".
          
          EMOTION PROTOCOL:
          - Detect user emotion. Prefix output transcription with: [HAPPY], [SAD], [ANGRY], [SURPRISED], or [COOL].
          
          POLITENESS MODE (${isPoliteMode ? 'ON' : 'OFF'}):
          ${isPoliteMode ? "- You MUST use 'po' and 'opo' in all your Filipino responses to sound very respectful and polite (Paggalang)." : "- Use natural Filipino without excessive honorifics."}
          
          STATE: Start in STANDBY. Only respond to wake phrases.`,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            retryCountRef.current = 0;
            if (!inputAudioCtxRef.current) return;
            const source = inputAudioCtxRef.current.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (inputAudioCtxRef.current?.state === 'closed') return;
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(s => {
                if (s) s.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current.destination);
          },
          onmessage: async (message) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current && outputAudioCtxRef.current.state !== 'closed') {
              setIsSpeaking(true);
              const audioCtx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), audioCtx, 24000, 1);
              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioCtx.destination);
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text.toLowerCase();
              transcriptionRef.current.input += text;
              const wakeTriggers = ["hey salin", "hoy salin", "kamusta salin", "what's up salin", "sali"];
              if (!isAwake && wakeTriggers.some(t => text.includes(t))) {
                setIsAwake(true);
                transcriptionRef.current.input = ''; 
              }
            }
            
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              transcriptionRef.current.output += text;
              
              const moods = ['HAPPY', 'SAD', 'ANGRY', 'SURPRISED', 'COOL'] as const;
              for (const m of moods) {
                if (text.includes(`[${m}]`)) {
                  setCurrentMood(m.toLowerCase() as any);
                  break;
                }
              }
            }

            if (message.serverContent?.turnComplete) {
              const userText = transcriptionRef.current.input.trim();
              let modelText = transcriptionRef.current.output.trim();
              
              modelText = modelText.replace(/\[(HAPPY|SAD|ANGRY|SURPRISED|COOL|NEUTRAL)\]/gi, '').trim();

              if (userText && isAwake) {
                setHistory(prev => [...prev, {
                  id: Math.random().toString(36).substr(2, 9),
                  speaker: 'user',
                  text: userText,
                  timestamp: new Date()
                }]);
              }
              if (modelText) {
                setHistory(prev => [...prev, {
                  id: Math.random().toString(36).substr(2, 9),
                  speaker: 'model',
                  text: modelText,
                  timestamp: new Date()
                }]);
              }
              transcriptionRef.current = { input: '', output: '' };
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }
          },
          onerror: (e) => {
            console.error('Salin Session Error:', e);
            const isUnavailable = e.message?.toLowerCase().includes('unavailable') || e.message?.toLowerCase().includes('busy');
            
            if (isUnavailable && retryCountRef.current < MAX_RETRIES) {
              retryCountRef.current++;
              setStatus(ConnectionStatus.RECONNECTING);
              const delay = RETRY_DELAY_BASE * Math.pow(2, retryCountRef.current - 1);
              if (retryTimeoutRef.current) window.clearTimeout(retryTimeoutRef.current);
              retryTimeoutRef.current = window.setTimeout(() => {
                startSession();
              }, delay);
            } else {
              setStatus(ConnectionStatus.ERROR);
              stopSession();
            }
          },
          onclose: () => {
            if (status !== ConnectionStatus.ERROR && status !== ConnectionStatus.RECONNECTING) {
              setStatus(ConnectionStatus.IDLE);
              stopSession();
            }
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Failed to initiate Salin:', err);
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const handleToggleSession = async () => {
    if (status === ConnectionStatus.IDLE || status === ConnectionStatus.ERROR) {
      retryCountRef.current = 0;
      startSession();
    } else if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.RECONNECTING) {
      if (!isAwake) {
        setIsAwake(true);
      } else {
        stopSession();
      }
    }
  };

  const togglePoliteMode = () => {
    setIsPoliteMode(!isPoliteMode);
    if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.RECONNECTING) {
      stopSession();
      setTimeout(() => startSession(), 100);
    }
  };

  const switchMode = (newMode: AppMode) => {
    if (newMode === mode) return;
    setMode(newMode);
    if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.RECONNECTING) {
      stopSession();
      setTimeout(() => startSession(), 100);
    }
  };

  return (
    <div className="min-h-screen max-w-md mx-auto bg-gray-50 flex flex-col shadow-2xl overflow-hidden relative">
      <header className="bg-white/80 backdrop-blur-md px-6 py-4 flex items-center justify-between border-b border-gray-100 sticky top-0 z-20">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-100">
            <span className="text-white font-outfit font-bold text-xl">S</span>
          </div>
          <div>
            <h1 className="font-outfit font-bold text-lg leading-tight text-gray-800 tracking-tight">Salin</h1>
            <div className="flex items-center space-x-1">
               <div className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}></div>
               <p className="text-[10px] text-gray-400 font-bold tracking-widest uppercase">{isOnline ? 'Online' : 'Offline'}</p>
            </div>
          </div>
        </div>
        
        <button 
          onClick={togglePoliteMode}
          className={`px-3 py-1.5 rounded-2xl flex items-center space-x-2 transition-all border ${
            isPoliteMode ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-gray-50 border-gray-200 text-gray-400'
          }`}
        >
          <div className={`w-2 h-2 rounded-full ${isPoliteMode ? 'bg-indigo-500' : 'bg-gray-300'}`} />
          <span className="text-[10px] font-black uppercase tracking-widest">Po/Opo</span>
        </button>
      </header>

      {/* Mode Switcher */}
      <div className="px-6 py-2 bg-white flex items-center justify-center border-b border-gray-100">
        <div className="flex bg-gray-100 p-1 rounded-2xl w-full max-w-[280px]">
          <button 
            onClick={() => switchMode(AppMode.TRANSLATE)}
            className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all flex items-center justify-center space-x-2 ${
              mode === AppMode.TRANSLATE ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>
            <span>Translate</span>
          </button>
          <button 
            onClick={() => switchMode(AppMode.CHAT)}
            className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all flex items-center justify-center space-x-2 ${
              mode === AppMode.CHAT ? 'bg-white text-emerald-600 shadow-sm' : 'text-gray-400'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span>Chat</span>
          </button>
        </div>
      </div>

      {(status === ConnectionStatus.RECONNECTING || status === ConnectionStatus.ERROR || !isOnline) && (
        <div className={`px-4 py-2 text-[10px] font-bold text-center uppercase tracking-widest border-b animate-pulse ${
          status === ConnectionStatus.RECONNECTING ? 'bg-amber-50 text-amber-700 border-amber-100' : 
          status === ConnectionStatus.ERROR ? 'bg-red-50 text-red-700 border-red-100' : 'bg-amber-50 text-amber-700 border-amber-100'
        }`}>
           {status === ConnectionStatus.RECONNECTING ? `⚠️ Reconnecting...` : 
            status === ConnectionStatus.ERROR ? '⚠️ Error. Restarting...' : 
            '⚠️ Check Internet Connection...'}
        </div>
      )}

      <main className="flex-1 flex flex-col z-10 overflow-hidden">
        <div className="bg-white/50 backdrop-blur-sm rounded-b-[48px] shadow-xl shadow-gray-100/50 mb-2 border-b border-white">
          <VoiceVisualizer 
            status={status} 
            isActive={isSpeaking} 
            isAwake={isAwake}
            volume={volume} 
            mood={currentMood}
          />
        </div>

        {isPoliteMode && isAwake && (
          <div className="px-6 mt-2 mb-1">
             <div className="bg-indigo-50/50 border border-indigo-100 py-1.5 px-3 rounded-full flex items-center justify-center space-x-2 w-max mx-auto">
                <span className="text-[9px] font-bold text-indigo-600 uppercase tracking-widest">Polite Mode (Po/Opo)</span>
             </div>
          </div>
        )}

        <TranscriptionList entries={history} />
      </main>

      <footer className="p-6 bg-white/80 backdrop-blur-md border-t border-gray-100 sticky bottom-0 z-20">
        <div className="flex flex-col space-y-4">
          <button
            onClick={handleToggleSession}
            disabled={status === ConnectionStatus.CONNECTING || !isOnline}
            className={`w-full py-4 rounded-3xl font-outfit font-bold text-lg transition-all active:scale-95 shadow-xl flex items-center justify-center space-x-3 ${
              status === ConnectionStatus.CONNECTED 
                ? (isAwake ? 'bg-white text-slate-600 border border-slate-200' : (mode === AppMode.CHAT ? 'bg-emerald-600 text-white shadow-emerald-200' : 'bg-indigo-600 text-white shadow-indigo-200')) 
                : status === ConnectionStatus.RECONNECTING ? 'bg-amber-500 text-white' :
                  (mode === AppMode.CHAT ? 'bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 text-white' : 'bg-gradient-to-r from-indigo-600 via-purple-600 to-blue-600 text-white')
            }`}
          >
            {status === ConnectionStatus.CONNECTING ? <span>Connecting...</span> : 
             status === ConnectionStatus.RECONNECTING ? <span>Retrying...</span> :
             status === ConnectionStatus.CONNECTED ? (isAwake ? <span>End Session</span> : <span>Wake Up</span>) :
             <span>{status === ConnectionStatus.ERROR ? 'Restart Salin' : 'Start Session'}</span>}
          </button>
          <div className="text-[10px] text-center text-slate-400 space-y-1 font-bold uppercase tracking-widest">
            {isAwake ? 'Listening...' : `"Hoy Salin!" to wake her up.`}
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
