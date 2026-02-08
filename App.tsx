
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
    [inputAudioCtxRef, outputAudioCtxRef].forEach(ctxRef => {
      if (ctxRef.current && ctxRef.current.state !== 'closed') {
        try { ctxRef.current.close(); } catch (e) {}
        ctxRef.current = null;
      }
    });
    setStatus(ConnectionStatus.IDLE);
    setIsSpeaking(false);
    setIsAwake(false);
    isConnectingRef.current = false;
  }, []);

  const startSession = async () => {
    if (!isOnline) {
      setErrorMessage('Offline. Please check your internet connection.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    setErrorMessage('');
    setStatus(ConnectionStatus.CONNECTING);

    try {
      // Check for key selection bridge
      if (typeof window !== 'undefined' && (window as any).aistudio) {
        const hasKey = await (window as any).aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await (window as any).aistudio.openSelectKey();
          // Race condition mitigation: Proceed immediately after trigger
        }
      }

      // Always create a fresh instance to ensure latest key is used
      const apiKey = process.env.API_KEY || '';
      const ai = new GoogleGenAI({ apiKey });
      
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
      inputAudioCtxRef.current = new AudioCtx({ sampleRate: 16000 });
      outputAudioCtxRef.current = new AudioCtx({ sampleRate: 24000 });
      
      await inputAudioCtxRef.current.resume();
      await outputAudioCtxRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const modeInstruction = mode === AppMode.TRANSLATE 
        ? "PURE TRANSLATION MODE: Professional English-Filipino translator. Output ONLY the translation. No conversation."
        : "CHAT MODE: You are Salin, a friendly English-Filipino assistant.";

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `${modeInstruction} ${isPoliteMode ? 'Use polite Filipino (po/opo).' : ''} Wake word: 'Hoy Salin'.`,
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
              if (inputAudioCtxRef.current?.state === 'closed') return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(s => s && s.sendRealtimeInput({ media: pcmBlob })).catch(() => {});
              
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
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
              if (text.includes("salin")) setIsAwake(true);
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.output += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              const uTxt = transcriptionRef.current.input.trim();
              const mTxt = transcriptionRef.current.output.trim();
              if (uTxt && isAwake) {
                const entry = (s: 'user'|'model', t: string): TranscriptionEntry => ({
                  id: Math.random().toString(36).substr(2, 9),
                  speaker: s, text: t, timestamp: new Date(), mode
                });
                const setter = mode === AppMode.TRANSLATE ? setTranslateHistory : setChatHistory;
                setter(prev => [...prev, entry('user', uTxt)]);
                if (mTxt) setter(prev => [...prev, entry('model', mTxt)]);
              }
              transcriptionRef.current = { input: '', output: '' };
            }
          },
          onerror: (e: any) => {
            console.error('Session error:', e);
            
            // Critical recovery: If entity not found (usually API key issue), prompt user again
            if (e.message?.includes('Requested entity was not found') || e.message?.includes('not found')) {
               (window as any).aistudio?.openSelectKey();
            }

            if (retryCountRef.current < MAX_RETRIES) {
              retryCountRef.current++;
              setTimeout(startSession, 1500);
            } else {
              setErrorMessage(e.message || 'Connection failed. Check API Key.');
              setStatus(ConnectionStatus.ERROR);
              stopSession();
            }
          },
          onclose: () => stopSession()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Start error:', err);
      setStatus(ConnectionStatus.ERROR);
      setErrorMessage(err.message || 'Connection error.');
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
          className={`px-3 py-1.5 rounded-2xl border text-[10px] font-black uppercase transition-all ${isPoliteMode ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-gray-50 text-gray-400'}`}
        >
          Po/Opo
        </button>
      </header>

      <div className="px-6 py-2 bg-white flex justify-center border-b border-gray-100">
        <div className="flex bg-gray-100 p-1 rounded-2xl w-full max-w-[280px]">
          <button onClick={() => { setMode(AppMode.TRANSLATE); stopSession(); }} className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase transition-all ${mode === AppMode.TRANSLATE ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400'}`}>Translate</button>
          <button onClick={() => { setMode(AppMode.CHAT); stopSession(); }} className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase transition-all ${mode === AppMode.CHAT ? 'bg-white text-emerald-600 shadow-sm' : 'text-gray-400'}`}>Chat</button>
        </div>
      </div>

      {status === ConnectionStatus.ERROR && (
        <div className="px-6 py-3 bg-red-50 border-b border-red-100">
          <p className="text-[10px] font-bold text-red-700 uppercase mb-1">Status Error</p>
          <p className="text-[11px] text-red-600 leading-tight">{errorMessage}</p>
        </div>
      )}

      <main className="flex-1 flex flex-col z-10 overflow-hidden">
        <div className="bg-white/50 backdrop-blur-sm rounded-b-[48px] shadow-xl shadow-gray-100/50 border-b border-white">
          <VoiceVisualizer status={status} isActive={isSpeaking} isAwake={isAwake} volume={volume} mood="neutral" />
        </div>
        <TranscriptionList entries={mode === AppMode.TRANSLATE ? translateHistory : chatHistory} />
      </main>

      <footer className="p-6 bg-white/80 backdrop-blur-md border-t border-gray-100 sticky bottom-0 z-20">
        <button
          onClick={status === ConnectionStatus.CONNECTED ? (isAwake ? stopSession : () => setIsAwake(true)) : startSession}
          disabled={status === ConnectionStatus.CONNECTING}
          className={`w-full py-4 rounded-3xl font-outfit font-bold text-lg transition-all active:scale-95 shadow-xl ${
            status === ConnectionStatus.CONNECTED ? (isAwake ? 'bg-white border border-slate-200 text-slate-600' : 'bg-indigo-600 text-white shadow-indigo-200') :
            status === ConnectionStatus.CONNECTING ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-indigo-600 text-white shadow-indigo-200'
          }`}
        >
          {status === ConnectionStatus.CONNECTING ? 'Connecting...' : 
           status === ConnectionStatus.CONNECTED ? (isAwake ? 'End Session' : 'Wake Up Salin') :
           'Start Translator'}
        </button>
        <div className="mt-4 flex flex-col items-center space-y-1">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
            {isAwake ? "Listening for speech..." : "Tap to start voice activation"}
          </p>
          {!process.env.API_KEY && (
            <button onClick={() => (window as any).aistudio?.openSelectKey()} className="text-[9px] text-indigo-500 font-bold uppercase underline">
              Update API Key
            </button>
          )}
        </div>
      </footer>
    </div>
  );
};

export default App;
