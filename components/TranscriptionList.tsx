
import React, { useEffect, useRef } from 'react';
import { TranscriptionEntry } from '../types';

interface TranscriptionListProps {
  entries: TranscriptionEntry[];
}

const TranscriptionList: React.FC<TranscriptionListProps> = ({ entries }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [entries]);

  return (
    <div 
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-h-[40vh] scroll-smooth"
    >
      {entries.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-gray-400 text-sm italic space-y-2 opacity-50 mt-10">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20v-6M9 20v-10M6 20v-4M15 20v-8M18 20v-12"/></svg>
          <p>Translate speech instantly...</p>
        </div>
      ) : (
        <>
          {entries.map((entry) => (
            <div 
              key={entry.id}
              className={`flex flex-col ${entry.speaker === 'user' ? 'items-end' : 'items-start'} transition-all animate-in fade-in slide-in-from-bottom-2`}
            >
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm ${
                entry.speaker === 'user' 
                  ? 'bg-indigo-600 text-white rounded-tr-none' 
                  : 'bg-white text-gray-800 border border-gray-100 rounded-tl-none'
              }`}>
                <p className="text-sm font-medium leading-relaxed">{entry.text}</p>
              </div>
              <span className="text-[9px] font-bold text-gray-400 mt-1 px-1 uppercase tracking-tighter">
                {entry.speaker === 'user' ? 'You' : 'Salin'} • {entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))}
          <div ref={endRef} className="h-4" />
        </>
      )}
    </div>
  );
};

export default TranscriptionList;
