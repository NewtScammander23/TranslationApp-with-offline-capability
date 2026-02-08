
import React, { useEffect, useState } from 'react';

interface VoiceVisualizerProps {
  status: string;
  isActive: boolean;
  isAwake: boolean;
  volume: number;
  mood: 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'cool';
}

const VoiceVisualizer: React.FC<VoiceVisualizerProps> = ({ status, isActive, isAwake, volume, mood }) => {
  const [blink, setBlink] = useState(false);
  const normalizedVolume = Math.min(100, volume * 500);

  useEffect(() => {
    if (!isAwake && !isActive) return;
    const blinkInterval = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 150);
    }, Math.random() * 4000 + 2000);
    return () => clearInterval(blinkInterval);
  }, [isAwake, isActive]);

  const actuallyAwake = isAwake || isActive;

  const getCoreColor = () => {
    if (status !== 'CONNECTED') return 'bg-gray-300';
    if (!actuallyAwake) return 'bg-gradient-to-br from-slate-700 to-slate-900';
    
    switch(mood) {
      case 'happy': return 'bg-gradient-to-br from-yellow-400 via-orange-500 to-red-500';
      case 'angry': return 'bg-gradient-to-br from-red-600 to-red-900';
      case 'sad': return 'bg-gradient-to-br from-blue-700 to-indigo-900';
      case 'surprised': return 'bg-gradient-to-br from-cyan-400 to-blue-600';
      case 'cool': return 'bg-gradient-to-br from-emerald-400 to-teal-600';
      default: return isActive ? 'bg-gradient-to-br from-indigo-500 to-purple-600' : 'bg-gradient-to-br from-blue-500 to-indigo-600';
    }
  };

  const getEyebrowTransform = (side: 'left' | 'right') => {
    if (!actuallyAwake) return 'translateY(4px)';
    const base = side === 'left' ? 'rotate(5deg)' : 'rotate(-5deg)';
    
    switch(mood) {
      case 'angry': return side === 'left' ? 'rotate(20deg) translateY(2px)' : 'rotate(-20deg) translateY(2px)';
      case 'happy': return side === 'left' ? 'rotate(-10deg) translateY(-4px)' : 'rotate(10deg) translateY(-4px)';
      case 'sad': return side === 'left' ? 'rotate(15deg) translateY(3px)' : 'rotate(-15deg) translateY(3px)';
      case 'surprised': return 'translateY(-8px) scale(1.1)';
      default: return base;
    }
  };

  const getMouthStyle = () => {
    if (!actuallyAwake) return { width: '20px', height: '2px', borderRadius: '2px' };
    if (isActive) return { width: '40px', height: '20px', borderRadius: '5px 5px 20px 20px' };
    
    switch(mood) {
      case 'happy': return { width: '32px', height: '14px', borderRadius: '0 0 50px 50px' };
      case 'sad': return { width: '32px', height: '8px', borderRadius: '50px 50px 0 0', marginTop: '10px' };
      case 'angry': return { width: '28px', height: '4px', borderRadius: '2px', backgroundColor: 'white' };
      case 'surprised': return { width: '24px', height: '24px', borderRadius: '50%' };
      case 'cool': return { width: '30px', height: '3px', borderRadius: '2px' };
      default: return { width: '24px', height: '2px', borderRadius: '100px' };
    }
  };

  return (
    <div className="flex flex-col items-center justify-center p-8 space-y-6 select-none">
      <div className="relative flex items-center justify-center">
        {/* Atmosphere Pulse */}
        <div 
          className={`absolute w-64 h-64 rounded-full opacity-10 blur-xl transition-all duration-1000 ${actuallyAwake ? 'scale-125' : 'scale-75'} ${getCoreColor()}`}
        />
        
        {/* Face */}
        <div className={`z-10 w-40 h-40 rounded-full flex flex-col items-center justify-center shadow-2xl transition-all duration-700 overflow-hidden relative border-4 ${actuallyAwake ? 'border-white/30' : 'border-black/10'} ${getCoreColor()}`}>
          
          {/* Eyebrows */}
          <div className="flex space-x-12 absolute top-10">
            <div className="w-8 h-1.5 bg-white/40 rounded-full transition-transform duration-500" style={{ transform: getEyebrowTransform('left') }} />
            <div className="w-8 h-1.5 bg-white/40 rounded-full transition-transform duration-500" style={{ transform: getEyebrowTransform('right') }} />
          </div>

          {/* Eyes */}
          <div className={`flex space-x-10 mb-2 mt-4 transition-all duration-300 ${mood === 'surprised' ? 'scale-125' : ''}`}>
            <div className={`bg-white rounded-full transition-all duration-300 ${
              !actuallyAwake || blink ? 'h-1 w-8 mt-2 opacity-50' : mood === 'cool' ? 'h-1.5 w-8' : 'h-6 w-6'
            } ${mood === 'angry' ? 'skew-y-12' : ''}`} />
            <div className={`bg-white rounded-full transition-all duration-300 ${
              !actuallyAwake || blink ? 'h-1 w-8 mt-2 opacity-50' : mood === 'cool' ? 'h-1.5 w-8' : 'h-6 w-6'
            } ${mood === 'angry' ? '-skew-y-12' : ''}`} />
          </div>

          {/* Mouth */}
          <div className="flex items-center justify-center h-10 w-24">
            <div className="bg-white/90 transition-all duration-500" style={getMouthStyle()} />
          </div>
        </div>
      </div>
      
      <div className="text-center">
        <h2 className="text-2xl font-outfit font-bold text-gray-800 tracking-tight capitalize">
          {status !== 'CONNECTED' ? "Meet Salin" : 
           !actuallyAwake ? "Salin is Napping" : 
           isActive ? `Salin is Feeling ${mood}!` : `Salin is listening...`}
        </h2>
        <div className="mt-2 flex justify-center">
          {actuallyAwake && (
            <div className="px-3 py-1 bg-indigo-50 border border-indigo-100 rounded-full flex items-center space-x-2">
              <span className="w-2 h-2 bg-indigo-500 rounded-full animate-ping" />
              <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">
                Detection: {mood}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VoiceVisualizer;
