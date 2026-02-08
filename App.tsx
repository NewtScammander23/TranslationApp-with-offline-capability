
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry, AppMode } from './types';
import { decode, decodeAudioData, createBlob } from './services/audio-helpers';
import VoiceVisualizer from './components/VoiceVisualizer';
import TranscriptionList from './components/TranscriptionList';

const MAX_RETRIES = 1;

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

  const sessionRef = useRef<any>(null);
  const isConnectingRef = useRef(false);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionRef = useRef<{ input: string, output: string }>({ input: '', output: '' });
  const retryCountRef = useRef(0);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => { setIsOnline(false); stopSession(); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    
    if (inputAudioCtxRef.current) {
      try { inputAudioCtxRef.current.close(); } catch (e) {}
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      try { outputAudioCtxRef.current.close(); } catch (e) {}
      outputAudioCtxRef.current = null;
    }
    
    setStatus(ConnectionStatus.IDLE);
    setIsSpeaking(false);
    setIsAwake(false);
    isConnectingRef.current = false;
  }, []);

  const startSession = async () => {
    if (!isOnline) {
      setErrorMessage('Please check your internet connection.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    setErrorMessage('');
    setStatus(ConnectionStatus.CONNECTING);

    try {
      // Mandatory for high-tier preview models: trigger key selection if not found
      if (typeof window !== 'undefined' && (window as any).aistudio) {
        const hasKey = await (window as any).aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await (window as any).aistudio.openSelectKey();
        }
      }

      // Initialize SDK exactly before use with current API_KEY from environment
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
      inputAudioCtxRef.current = new AudioCtx({ sampleRate: 16000 });
      outputAudioCtxRef.current = new AudioCtx({ sampleRate: 24000 });
      
      // Ensure contexts are resumed after user gesture
      await inputAudioCtxRef.current.resume();
      await outputAudioCtxRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const modeInstruction = mode === AppMode.TRANSLATE 
        ? "PURE TRANSLATION MODE: You are an expert English-Filipino interpreter. If user speaks English, translate to Tagalog. If user speaks Tagalog, translate to English. Output ONLY the translation without chatter."
        : "CHAT MODE: You are Salin, a friendly English-Filipino assistant who uses natural 'Taglish'.";

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `${modeInstruction} ${isPoliteMode ? 'Be very polite (po/opo).' : 'Be casual and natural.'} Wake word is 'Hoy Salin'.`,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            isConnectingRef.current = false;
            retryCountRef.current = 0;
            
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (!inputAudioCtxRef.current || inputAudioCtxRef.current.state === 'closed') return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              
              // Use sessionPromise directly as per SDK rules to avoid race conditions
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
              
              // Basic volume detection for visualizer
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (message) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current && outputAudioCtxRef.current.state !== 'closed') {
              setIsSpeaking(true);
              const audioCtx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtx.currentTime);
              
              // Custom decoding logic for raw PCM as required by SDK
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
              if (text.includes("salin") || text.includes("hoy")) setIsAwake(true);
            }
            
            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.output += message.serverContent.outputTranscription.text;
            }
            
            if (message.serverContent?.turnComplete) {
              const uText = transcriptionRef.current.input.trim();
              const mText = transcriptionRef.current.output.trim();
              
              if (uText && isAwake) {
                const entry = (s: 'user'|'model', t: string): TranscriptionEntry => ({
                  id: Math.random().toString(36).substr(2, 9),
                  speaker: s, text: t, timestamp: new Date(), mode
                });
                
                const setter = mode === AppMode.TRANSLATE ? setTranslateHistory : setChatHistory;
                setter(prev => [...prev, entry('user', uText)]);
                if (mText) setter(prev => [...prev, entry('model', mText)]);
              }
              transcriptionRef.current = { input: '', output: '' };
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              setIsSpeaking(false);
            }
          },
          onerror: (e: any) => {
            console.error('Session error:', e);
            
            // Handle entity not found by resetting key selection state as per rules
            if (e.message?.includes('Requested entity was not found') || e.message?.includes('not found')) {
              if (typeof window !== 'undefined' && (window as any).aistudio) {
                (window as any).aistudio.openSelectKey();
              }
            }

            if (retryCountRef.current < MAX_RETRIES) {
              retryCountRef.current++;
              setTimeout(startSession, 2000);
            } else {
              setErrorMessage(e.message || 'Connection failed. Please check your API key and region.');
              setStatus(ConnectionStatus.ERROR);
              stopSession();
            }
          },
          onclose: () => stopSession()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Startup error:', err);
      setStatus(ConnectionStatus.ERROR);
      setErrorMessage(err.message || 'Microphone access denied or connection error.');
      isConnectingRef.current = false;
    }
  };

  return (
    <div className="min-h-screen max-w-md mx-auto bg-gray-50 flex flex-col shadow-2xl overflow-hidden relative">
      <header className="bg-white/80 backdrop-blur-md px-6 py-4 flex items-center justify-between border-b border-gray-100 sticky top-0 z-20">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg">
            <span className="text-white font-outfit font-bold text-xl">S</span>
          </div>
          <h1 className="font-outfit font-bold text-lg text-gray-800">Salin</h1>
        </div>
        <button 
          onClick={() => setIsPoliteMode(!isPoliteMode)} 
          className={`px-3 py-1.5 rounded-2xl border text-[10px] font-black uppercase transition-all shadow-sm ${
            isPoliteMode ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-gray-50 text-gray-400 border-gray-100'
          }`}
        >
          Po/Opo
        </button>
      </header>

      <div className="px-6 py-2 bg-white flex justify-center border-b border-gray-100">
        <div className="flex bg-gray-100 p-1 rounded-2xl w-full max-w-[280px]">
          <button 
            onClick={() => { setMode(AppMode.TRANSLATE); stopSession(); }} 
            className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase transition-all ${mode === AppMode.TRANSLATE ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400'}`}
          >
            Translate
          </button>
          <button 
            onClick={() => { setMode(AppMode.CHAT); stopSession(); }} 
            className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase transition-all ${mode === AppMode.CHAT ? 'bg-white text-emerald-600 shadow-sm' : 'text-gray-400'}`}
          >
            Chat
          </button>
        </div>
      </div>

      {status === ConnectionStatus.ERROR && (
        <div className="px-6 py-3 bg-red-50 border-b border-red-100 animate-in slide-in-from-top">
          <p className="text-[10px] font-bold text-red-700 uppercase mb-1">Service Error</p>
          <p className="text-[11px] text-red-600 leading-tight font-medium">{errorMessage}</p>
        </div>
      )}

      <main className="flex-1 flex flex-col z-10 overflow-hidden bg-white/30">
        <div className="bg-white/50 backdrop-blur-sm rounded-b-[48px] shadow-xl shadow-gray-100/50 border-b border-white">
          <VoiceVisualizer status={status} isActive={isSpeaking} isAwake={isAwake} volume={volume} mood="neutral" />
        </div>
        <TranscriptionList entries={mode === AppMode.TRANSLATE ? translateHistory : chatHistory} />
      </main>

      <footer className="p-6 bg-white/90 backdrop-blur-md border-t border-gray-100 sticky bottom-0 z-20">
        <button
          onClick={status === ConnectionStatus.CONNECTED ? (isAwake ? stopSession : () => setIsAwake(true)) : startSession}
          disabled={status === ConnectionStatus.CONNECTING}
          className={`w-full py-4 rounded-3xl font-outfit font-bold text-lg transition-all active:scale-95 shadow-2xl ${
            status === ConnectionStatus.CONNECTED 
              ? (isAwake ? 'bg-white border-2 border-slate-200 text-slate-600' : 'bg-gradient-to-r from-indigo-600 to-indigo-700 text-white') 
              : status === ConnectionStatus.CONNECTING ? 'bg-gray-100 text-gray-400' : 'bg-gradient-to-r from-indigo-600 to-indigo-700 text-white'
          }`}
        >
          {status === ConnectionStatus.CONNECTING ? 'Initializing...' : 
           status === ConnectionStatus.CONNECTED ? (isAwake ? 'Stop Interpreter' : 'Awaken Salin') :
           'Start Interpreter'}
        </button>
        
        <div className="mt-4 flex flex-col items-center space-y-1">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center">
            {isAwake ? "Salin is ready to translate" : "Tap button to begin voice session"}
          </p>
          {status === ConnectionStatus.ERROR && (
            <button 
              onClick={() => (window as any).aistudio?.openSelectKey()} 
              className="text-[9px] text-indigo-500 font-bold uppercase underline mt-2"
            >
              Reconfigure API Key
            </button>
          )}
        </div>
      </footer>
    </div>
  );
};

export default App;
