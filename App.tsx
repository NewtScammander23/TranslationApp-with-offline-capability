
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry, AppMode } from './types';
import { decode, decodeAudioData, createBlob } from './services/audio-helpers';
import VoiceVisualizer from './components/VoiceVisualizer';
import TranscriptionList from './components/TranscriptionList';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [mode, setMode] = useState<AppMode>(AppMode.TRANSLATE);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  
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
      setErrorMessage('Internet connection required.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErrorMessage('Your browser does not support microphone access or you are not in a secure (HTTPS) environment.');
      setStatus(ConnectionStatus.ERROR);
      return;
    }

    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    setErrorMessage('');
    setMicPermissionDenied(false);
    setStatus(ConnectionStatus.CONNECTING);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
    } catch (err: any) {
      isConnectingRef.current = false;
      setStatus(ConnectionStatus.ERROR);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setMicPermissionDenied(true);
        setErrorMessage('Microphone access was denied. Please allow microphone permissions in your browser settings.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setErrorMessage('No microphone was found on your device.');
      } else {
        setErrorMessage(`Microphone error: ${err.message}`);
      }
      return;
    }

    try {
      const apiKey = process.env.API_KEY || '';
      if (!apiKey) throw new Error("API Key is missing.");

      const ai = new GoogleGenAI({ apiKey });
      
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
      inputAudioCtxRef.current = new AudioCtx({ sampleRate: 16000 });
      outputAudioCtxRef.current = new AudioCtx({ sampleRate: 24000 });
      
      await inputAudioCtxRef.current.resume();
      await outputAudioCtxRef.current.resume();

      const modeInstruction = mode === AppMode.TRANSLATE 
        ? "You are a specialized bidirectional English-Filipino speech-to-speech interpreter. If you hear English, translate to Filipino. If you hear Filipino, translate to English. ONLY speak the translation. No commentary."
        : "You are Salin, a helpful English-Filipino assistant. Use natural Taglish.";

      const politePrompt = isPoliteMode ? 'Always use "po" and "opo" in Filipino.' : 'Use casual and natural phrasing.';

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `${modeInstruction} ${politePrompt} Speak naturally and quickly.`,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsAwake(true);
            isConnectingRef.current = false;
            
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (!inputAudioCtxRef.current || inputAudioCtxRef.current.state === 'closed') return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
              
              const outputData = e.outputBuffer.getChannelData(0);
              outputData.fill(0);
              
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
              transcriptionRef.current.input += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionRef.current.output += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              const uText = transcriptionRef.current.input.trim();
              const mText = transcriptionRef.current.output.trim();
              if (uText) {
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
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: any) => {
            console.error('Session error:', e);
            setErrorMessage(e.message || 'The session encountered an error.');
            setStatus(ConnectionStatus.ERROR);
            stopSession();
          },
          onclose: () => stopSession()
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Startup error:', err);
      setStatus(ConnectionStatus.ERROR);
      setErrorMessage(err.message || 'Failed to initialize AI session.');
      isConnectingRef.current = false;
      if (stream) stream.getTracks().forEach(track => track.stop());
    }
  };

  const clearHistory = () => {
    if (mode === AppMode.TRANSLATE) setTranslateHistory([]);
    else setChatHistory([]);
  };

  return (
    <div className="min-h-screen max-w-md mx-auto bg-gray-50 flex flex-col shadow-2xl overflow-hidden relative border-x border-gray-100">
      <header className="bg-white/90 backdrop-blur-md px-6 py-4 flex items-center justify-between border-b border-gray-100 sticky top-0 z-20">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gradient-to-tr from-indigo-600 to-indigo-800 rounded-xl flex items-center justify-center shadow-lg">
            <span className="text-white font-outfit font-bold text-xl">S</span>
          </div>
          <div>
            <h1 className="font-outfit font-bold text-lg text-gray-800 leading-none">Salin</h1>
            <p className="text-[9px] font-bold text-indigo-500 uppercase tracking-widest mt-1">Live AI Interpreter</p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <button 
            onClick={clearHistory}
            className="p-2 text-gray-400 hover:text-red-500 transition-colors"
            title="Clear History"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/></svg>
          </button>
          <button 
            onClick={() => setIsPoliteMode(!isPoliteMode)} 
            className={`px-3 py-1.5 rounded-2xl border text-[10px] font-black uppercase transition-all shadow-sm ${
              isPoliteMode ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-gray-50 text-gray-400 border-gray-100'
            }`}
          >
            {isPoliteMode ? 'Polite' : 'Casual'}
          </button>
        </div>
      </header>

      <div className="px-6 py-3 bg-white flex justify-center border-b border-gray-100">
        <div className="flex bg-gray-100 p-1 rounded-2xl w-full">
          <button 
            onClick={() => { setMode(AppMode.TRANSLATE); stopSession(); }} 
            className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${mode === AppMode.TRANSLATE ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400'}`}
          >
            Translate
          </button>
          <button 
            onClick={() => { setMode(AppMode.CHAT); stopSession(); }} 
            className={`flex-1 py-2 px-4 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${mode === AppMode.CHAT ? 'bg-white text-emerald-600 shadow-sm' : 'text-gray-400'}`}
          >
            Chat
          </button>
        </div>
      </div>

      {status === ConnectionStatus.ERROR && (
        <div className="px-6 py-4 bg-red-50 border-b border-red-100 animate-in slide-in-from-top">
          <div className="flex items-start space-x-3">
            <div className="mt-0.5 text-red-600">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div>
              <p className="text-[11px] text-red-700 leading-tight font-bold uppercase mb-1">Error Occurred</p>
              <p className="text-[12px] text-red-600 leading-snug">{errorMessage}</p>
              {micPermissionDenied && (
                <button 
                  onClick={() => window.location.reload()}
                  className="mt-2 text-[10px] font-black text-red-700 uppercase underline tracking-wider"
                >
                  Refresh and Try Again
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col z-10 overflow-hidden bg-white/40">
        <div className="bg-white/80 backdrop-blur-md rounded-b-[40px] shadow-sm border-b border-white">
          <VoiceVisualizer status={status} isActive={isSpeaking} isAwake={isAwake} volume={volume} mood="neutral" />
        </div>
        <TranscriptionList entries={mode === AppMode.TRANSLATE ? translateHistory : chatHistory} />
      </main>

      <footer className="p-6 bg-white border-t border-gray-100 sticky bottom-0 z-20">
        <button
          onClick={status === ConnectionStatus.CONNECTED ? stopSession : startSession}
          disabled={status === ConnectionStatus.CONNECTING}
          className={`w-full py-4 rounded-3xl font-outfit font-bold text-lg transition-all active:scale-95 shadow-xl ${
            status === ConnectionStatus.CONNECTED 
              ? 'bg-slate-100 text-slate-600 border border-slate-200' 
              : status === ConnectionStatus.CONNECTING ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-gradient-to-r from-indigo-600 to-indigo-800 text-white'
          }`}
        >
          {status === ConnectionStatus.CONNECTING ? 'Connecting...' : 
           status === ConnectionStatus.CONNECTED ? 'Stop Interpreter' :
           'Start Translation'}
        </button>
        
        <p className="mt-4 text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] text-center">
          {status === ConnectionStatus.CONNECTED ? "Salin is Listening..." : "Tap to activate microphone"}
        </p>
      </footer>
    </div>
  );
};

export default App;
