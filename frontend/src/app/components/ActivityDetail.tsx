import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { 
  ArrowLeft, Calendar, User, Info, 
  Clock, ChevronRight, AlertCircle 
} from 'lucide-react';
import { useData } from '../state/DataContext';
import { formatShortDate } from '@/utils/dateFormatter';

export default function ActivityDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activities, children: allChildren } = useData();
  const [activity, setActivity] = useState<any>(null);
  const [participants, setParticipants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activities || activities.length === 0) return;
    const found = activities.find((a: any) => String(a.id) === String(id));
    if (found) {
      setActivity(found);
      const ids: string[] = Array.isArray(found.selectedResidentIds) ? found.selectedResidentIds : [];
      if (ids.length > 0) {
        setParticipants(allChildren.filter(c => ids.includes(c.id)).map(c => ({ id: c.id, name: c.name })));
      } else {
        setParticipants([]);
      }
    }
    setLoading(false);
  }, [id, activities, allChildren]);

  // 4. Loading State UI
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-[#2F3E46] border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="font-bold text-[#2F3E46] animate-pulse">Loading Activity Details...</p>
        </div>
      </div>
    );
  }

  // 5. Error State UI: Kapag talagang walang nahanap na record
  if (!activity) {
    return (
      <div className="h-screen flex flex-col items-center justify-center p-6 text-center">
        <AlertCircle size={48} className="text-red-500 mb-4" />
        <h2 className="text-2xl font-bold text-[#2F3E46]">Activity Not Found</h2>
        <p className="text-gray-500 mb-6">Maaaring nabura na ang record na ito o mali ang URL.</p>
        <Button onClick={() => navigate('/activities')} className="bg-[#2F3E46]">
          Back to Programs
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 p-4 animate-in fade-in duration-500">
      <Button 
        variant="ghost" 
        onClick={() => navigate('/activities')} 
        className="gap-2 text-gray-500 hover:text-[#2F3E46] p-0 h-auto font-medium transition-colors"
      >
        <ArrowLeft size={16} /> Back to Programs
      </Button>

      {/* Header Card */}
      <Card style={{ backgroundColor: '#2F3E46' }} className="border-none shadow-xl text-white overflow-hidden rounded-2xl">
        <CardContent className="p-8 relative">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
            <div className="space-y-4">
              <Badge style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }} className="text-white border-none px-3 py-1 text-xs uppercase tracking-wider font-bold">
                {activity.type}
              </Badge>
              <h1 className="text-4xl font-bold tracking-tight text-white">{activity.title}</h1>
              <div className="flex flex-wrap gap-6 text-gray-300 text-sm">
                <span className="flex items-center gap-2"><Calendar size={18} style={{ color: '#FFD100' }}/> {formatShortDate(activity.date)}</span>
                <span className="flex items-center gap-2"><Clock size={18} style={{ color: '#FFD100' }}/> {activity.time}</span>
                <span className="flex items-center gap-2"><User size={18} style={{ color: '#FFD100' }}/> PIC: {Array.isArray(activity.personInCharge) ? activity.personInCharge.join(', ') : activity.personInCharge}</span>
              </div>
            </div>
            <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)' }} className="border border-white/10 p-6 rounded-2xl backdrop-blur-sm text-center min-w-[140px]">
              <div className="text-4xl font-black text-[#FFD100]">{participants.length}</div>
              <div className="text-[10px] uppercase tracking-widest font-bold opacity-70 text-white">Participants</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Description */}
        <div className="lg:col-span-1 space-y-4">
          <div className="flex items-center gap-2" style={{ color: '#2F3E46' }}>
            <Info size={18} />
            <h2 className="font-bold uppercase tracking-wider text-sm">Program Description</h2>
          </div>
          <Card className="border-none shadow-sm bg-white rounded-xl">
            <CardContent className="p-6">
              <p className="text-gray-600 leading-relaxed text-sm">
                {activity.description || "No description provided for this activity."}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Resident List */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold" style={{ color: '#2F3E46' }}>List of Participants</h2>
            <Badge variant="outline" className="text-gray-400 border-gray-200 font-normal">
              {participants.length} Total
            </Badge>
          </div>
          <div className="grid gap-3">
            {participants.length > 0 ? (
              participants.map((resident) => (
                <Card key={resident.id} className="border-none shadow-sm hover:shadow-md transition-all bg-white rounded-xl group cursor-pointer">
                  <CardContent className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center font-bold border border-gray-100 group-hover:bg-[#FFD100]/10 group-hover:border-[#FFD100]/30 transition-all" style={{ color: '#2F3E46' }}>
                        {resident.name.charAt(0)}
                      </div>
                      <div>
                        <div className="font-bold transition-colors group-hover:text-[#2F3E46]" style={{ color: '#2F3E46' }}>{resident.name}</div>
                        <div className="text-[10px] text-gray-400 font-mono uppercase tracking-tighter">{resident.id}</div>
                      </div>
                    </div>
                    <ChevronRight size={18} className="text-gray-300 group-hover:text-[#2F3E46] transition-all group-hover:translate-x-1" />
                  </CardContent>
                </Card>
              ))
            ) : (
              <p className="text-center text-gray-400 py-10">Walang mga kalahok sa aktibidad na ito.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}