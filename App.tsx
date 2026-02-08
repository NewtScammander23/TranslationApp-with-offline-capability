
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry, AppMode } from './types';
import { decode, encode, decodeAudioData, createBlob } from './services/audio-helpers';
import VoiceVisualizer from './components/VoiceVisualizer';
import TranscriptionList from './components/TranscriptionList';

const MAX_RETRIES = 2;
const RETRY_DELAY_BASE = 1500;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [mode, setMode] = useState<AppMode>(AppMode.TRANSLATE);
  const [errorMessage, setErrorMessage] = useState<string>('');
  
  const [translateHistory, setTranslateHistory] = useState<TranscriptionEntry[]>([]);
  const [chatHistory, setChatHistory] = useState<TranscriptionEntry[]>([]);
  
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isAwake, setIsAwake] = useState(false);
  const [volume, setVolume] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isPoliteMode, setIsPoliteMode] = useState(false);
  const [currentMood, setCurrentMood] = useState<'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'cool'>('neutral');

  const sessionRef = useRef<any>(null);
  const isConnectingRef = useRef(false);
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
      } catch (e) {}
      sessionRef.current = null;
    }

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();

    const closeCtx = (ctxRef: React.MutableRefObject<AudioContext | null>) => {
      if (ctxRef.current) {
        if (ctxRef.current.state !== 'closed') {
          try {
            ctxRef.current.close().catch(() => {});
          } catch (e) {}
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
    isConnectingRef.current = false;
  }, []);

  const startSession = async () => {
    if (!isOnline) {
      setErrorMessage('Offline: Check your internet.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    setErrorMessage('');

    try {
      if (sessionRef.current) stopSession();

      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        // If API_KEY is missing, check if we can open the selection dialog
        if (typeof window !== 'undefined' && (window as any).aistudio) {
          const hasKey = await (window as any).aistudio.hasSelectedApiKey();
          if (!hasKey) {
            await (window as any).aistudio.openSelectKey();
            isConnectingRef.current = false;
            return; // Exit and let user try again after selecting key
          }
        } else {
          throw new Error("Missing API_KEY. Add it to Vercel Environment Variables.");
        }
      }

      setStatus(retryCountRef.current > 0 ? ConnectionStatus.RECONNECTING : ConnectionStatus.CONNECTING);
      
      const ai = new GoogleGenAI({ apiKey: apiKey || '' });
      
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioCtxRef.current = new AudioCtx({ sampleRate: 16000 });
      outputAudioCtxRef.current = new AudioCtx({ sampleRate: 24000 });
      
      await inputAudioCtxRef.current.resume();
      await outputAudioCtxRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true } 
      });

      const modeInstruction = mode === AppMode.TRANSLATE 
        ? "PURE TRANSLATION MODE: You are a translator. No chatting. Output ONLY the translation between English and Filipino."
        : `CHAT MODE: You are 'Salin', a bubbly Filipino-English bestie. Be human-like and lively!`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are 'Salin'. ${modeInstruction} Wake word: 'Hoy Salin'.`,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            isConnectingRef.current = false;
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
              sessionPromise.then(s => s && s.sendRealtimeInput({ media: pcmBlob })).catch(() => {});
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current.destination);
          },
          onmessage: async (message) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current?.state !== 'closed') {
              setIsSpeaking(true);
              const audioCtx = outputAudioCtxRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), audioCtx, 24000, 1);
              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioCtx.destination);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text.toLowerCase();
              transcriptionRef.current.input += text;
              if (!isAwake && text.includes("salin")) setIsAwake(true);
            }
            
            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.output += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const uTxt = transcriptionRef.current.input.trim();
              const mTxt = transcriptionRef.current.output.trim();
              if ((uTxt && isAwake) || mTxt) {
                const entry = (s: 'user'|'model', t: string): TranscriptionEntry => ({
                  id: Math.random().toString(36).substr(2, 9),
                  speaker: s, text: t, timestamp: new Date(), mode
                });
                const setter = mode === AppMode.TRANSLATE ? setTranslateHistory : setChatHistory;
                if (uTxt && isAwake) setter(p => [...p, entry('user', uTxt)]);
                if (mTxt) setter(p => [...p, entry('model', mTxt)]);
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
          onerror: (e: any) => {
            console.error('Session error:', e);
            isConnectingRef.current = false;
            
            // Handle key issues by opening the key selector
            if (e.message?.toLowerCase().includes('entity was not found') || e.message?.toLowerCase().includes('api key')) {
              if (typeof window !== 'undefined' && (window as any).aistudio) {
                (window as any).aistudio.openSelectKey();
              }
            }

            if (retryCountRef.current < MAX_RETRIES) {
              retryCountRef.current++;
              const delay = RETRY_DELAY_BASE * retryCountRef.current;
              retryTimeoutRef.current = window.setTimeout(() => startSession(), delay);
            } else {
              setErrorMessage(e.message || 'Connection failed. Check settings.');
              setStatus(ConnectionStatus.ERROR);
              stopSession();
            }
          },
          onclose: () => {
            if (status !== ConnectionStatus.ERROR && status !== ConnectionStatus.RECONNECTING) stopSession();
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Start error:', err);
      isConnectingRef.current = false;
      setStatus(ConnectionStatus.ERROR);
      if (err.name === 'NotAllowedError' || err.message?.includes('Permission denied')) {
        setErrorMessage('Allow Microphone access to use Salin.');
      } else {
        setErrorMessage(err.message || 'Service unreachable.');
      }
    } finally {
      // Safety release
      setTimeout(() => { if (status === ConnectionStatus.CONNECTING) isConnectingRef.current = false; }, 8000);
    }
  };

  const handleToggleSession = async () => {
    if (status === ConnectionStatus.IDLE || status === ConnectionStatus.ERROR) {
      retryCountRef.current = 0;
      await startSession();
    } else if (status === ConnectionStatus.CONNECTED) {
      if (!isAwake) setIsAwake(true);
      else stopSession();
    }
  };

  return (
    <div className="min-h-screen max-w-md mx-auto bg-gray-50 flex flex-col shadow-2xl overflow-hidden relative">
      <header className="bg-white/80 backdrop-blur-md px-6 py-4 flex items-center justify-between border-b border-gray-100 sticky top-0 z-20">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg">
            <span className="text-white font-outfit font-bold text-xl">S</span>
          </div>
          <div>
            <h1 className="font-outfit font-bold text-lg text-gray-800">Salin</h1>
            <div className="flex items-center space-x-1">
               <div className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}></div>
               <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{isOnline ? 'Online' : 'Offline'}</p>
            </div>
          </div>
        </div>
        <button onClick={() => setIsPoliteMode(!isPoliteMode)} className={`px-3 py-1.5 rounded-2xl border transition-all ${isPoliteMode ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-gray-50 text-gray-400'}`}>
          <span className="text-[10px] font-black uppercase tracking-widest">Po/Opo</span>
        </button>
      </header>

      <div className="px-6 py-2 bg-white flex justify-center border-b border-gray-100">
        <div className="flex bg-gray-100 p-1 rounded-2xl w-full max-w-[280px]">
          <button onClick={() => { if(mode!==AppMode.TRANSLATE){ setMode(AppMode.TRANSLATE); stopSession(); }}} className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase transition-all ${mode === AppMode.TRANSLATE ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400'}`}>Translate</button>
          <button onClick={() => { if(mode!==AppMode.CHAT){ setMode(AppMode.CHAT); stopSession(); }}} className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase transition-all ${mode === AppMode.CHAT ? 'bg-white text-emerald-600 shadow-sm' : 'text-gray-400'}`}>Chat</button>
        </div>
      </div>

      {status === ConnectionStatus.ERROR && (
        <div className="px-4 py-3 text-[10px] font-bold text-center uppercase bg-red-50 text-red-700 border-b border-red-100">
           ⚠️ {errorMessage || 'Service Error. Check settings.'}
        </div>
      )}

      <main className="flex-1 flex flex-col z-10 overflow-hidden">
        <div className="bg-white/50 backdrop-blur-sm rounded-b-[48px] shadow-xl shadow-gray-100/50 mb-2 border-b border-white">
          <VoiceVisualizer status={status} isActive={isSpeaking} isAwake={isAwake} volume={volume} mood={currentMood} />
        </div>
        <TranscriptionList entries={mode === AppMode.TRANSLATE ? translateHistory : chatHistory} />
      </main>

      <footer className="p-6 bg-white/80 backdrop-blur-md border-t border-gray-100 sticky bottom-0 z-20">
        <div className="flex flex-col space-y-4">
          <button
            onClick={handleToggleSession}
            disabled={status === ConnectionStatus.CONNECTING || !isOnline}
            className={`w-full py-4 rounded-3xl font-outfit font-bold text-lg transition-all active:scale-95 shadow-xl ${
              status === ConnectionStatus.CONNECTED ? (isAwake ? 'bg-white border border-slate-200 text-slate-600' : 'bg-indigo-600 text-white') :
              status === ConnectionStatus.CONNECTING ? 'bg-gray-200 text-gray-500' : 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white'
            }`}
          >
            {status === ConnectionStatus.CONNECTING ? 'Connecting...' : 
             status === ConnectionStatus.RECONNECTING ? 'Retrying...' :
             status === ConnectionStatus.CONNECTED ? (isAwake ? 'End Session' : 'Wake Up') :
             'Try Again'}
          </button>
          <p className="text-[10px] text-center text-slate-400 font-bold uppercase tracking-widest">
            {isAwake ? "Salin is listening!" : "Tap to start or say 'Hoy Salin'"}
          </p>
        </div>
      </footer>
    </div>
  );
};

export default App;
