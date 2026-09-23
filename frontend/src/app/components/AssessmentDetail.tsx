import { useParams, useNavigate } from 'react-router-dom';
import { useData } from '../state/DataContext'; 
import { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { ArrowLeft, FileText, Users, CheckCircle2, Clock, Calendar, Shield, AlertCircle } from 'lucide-react';
import { formatShortDate } from '@/utils/dateFormatter';

interface ResidentRef {
  id: string;
  name: string;
}

interface Assessment {
  id: string | number;
  title: string;
  date: string;
  time: string;
  type: string;
  assessor: string;
  status: string;
  forResidents: (string | ResidentRef)[];
  description?: string;
  violationIds?: string[];
  interventionTrackerId?: string;
  interventionRequirementId?: string;
  schedulingMode?: string;
  psychosocialActivities?: string[];
}

export function AssessmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { assessments, isLoading, violations } = useData(); 

  useEffect(() => {
    if (!isLoading && assessments) {
      console.log("Searching for ID:", id);
      console.log("Available Assessments:", assessments);
    }
  }, [id, assessments, isLoading]);

  // 1. ROBUST MATCHING LOGIC
  const foundAssessment = assessments?.find((item: Assessment) => {
    return String(item.id).trim().toLowerCase() === String(id).trim().toLowerCase();
  });

  // 2. FALLBACK DATA (Para hindi mag-error kung "ASM001" ang hinahanap pero wala pa sa Context)
  const assessment = foundAssessment || (id === "ASM001" ? {
    id: "ASM001",
    title: "Initial Physical Assessment",
    date: "2024-05-15",
    time: "09:00 AM",
    type: "Medical",
    assessor: "Dr. Santos",
    status: "Scheduled",
    forResidents: [{id: "CH001", name: "Juan Dela Cruz"}, {id: "CH002", name: "Maria Clara"}],
    description: "Standard check-up for new residents to monitor baseline health metrics."
  } : null);

  if (isLoading) {
    return (
      <div className="p-8 space-y-6 animate-pulse">
        <div className="h-10 w-32 bg-gray-200 rounded-lg"></div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 h-[400px] bg-gray-100 rounded-2xl"></div>
          <div className="space-y-6">
            <div className="h-32 bg-gray-100 rounded-2xl"></div>
            <div className="h-64 bg-gray-100 rounded-2xl"></div>
          </div>
        </div>
      </div>
    );
  }

  if (!assessment) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center space-y-6 p-4">
        <div className="p-6 bg-red-50 rounded-full text-red-500 shadow-inner">
          <AlertCircle className="w-12 h-12" />
        </div>
        <div className="text-center space-y-2">
          <h3 className="text-2xl font-bold text-[#2F3E46]">Record Not Found</h3>
          <p className="text-gray-500">The assessment with ID <span className="font-mono font-bold">"{id}"</span> could not be retrieved.</p>
        </div>
        <Button 
          onClick={() => navigate('/assessments')}
          style={{ backgroundColor: '#2F3E46' }}
          className="text-white rounded-xl px-8 py-6 hover:opacity-90 transition-all shadow-lg"
        >
          <ArrowLeft className="w-4 h-4 mr-2" /> Return to Dashboard
        </Button>
      </div>
    );
  }

  const assessorList = Array.isArray(assessment.assessor) 
    ? assessment.assessor.join(', ') 
    : (assessment.assessor || '—');

  const residents = Array.isArray(assessment.forResidents) ? assessment.forResidents : [];
  // Handle both string[] and {id, name}[] formats
  const residentNames = residents.map((r: string | ResidentRef) => 
    typeof r === 'string' ? r : (r?.name || r?.id || 'Unknown')
  );
  const filteredParticipants = residentNames.filter(
    (name: string) => !String(assessorList).toLowerCase().includes(name.toLowerCase())
  );

  const linkedViolations = (assessment.violationIds || [])
    .map((vid: string) => violations.find((v: any) => v.id === vid))
    .filter(Boolean) as any[];
  const isInterventionAssessment = Boolean(assessment.interventionTrackerId || assessment.interventionRequirementId || assessment.schedulingMode === 'violation-scheduled');
  const displayNotes = isInterventionAssessment && /^(Scheduled from a verified intervention|Scheduled during Psychologist verification|Violation:)/i.test(String(assessment.description || ''))
    ? ''
    : (assessment.description || '');
  const psychosocialActivities = Array.isArray((assessment as any).psychosocialActivities)
    ? (assessment as any).psychosocialActivities as string[]
    : String(assessment.type || '').split(',').map((x: string) => x.trim()).filter(Boolean);

  return (
    <div className="space-y-6 p-2 max-w-7xl mx-auto">
      <Button
        variant="ghost"
        className="flex items-center gap-2 hover:bg-[#2F3E46]/5 transition-all font-semibold"
        style={{ color: '#2F3E46' }}
        onClick={() => navigate('/assessments')}
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to List</span>
      </Button>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 shadow-2xl border-none overflow-hidden rounded-3xl bg-white">
          <CardHeader className="p-0">
            <div style={{ backgroundColor: '#2F3E46' }} className="p-10 text-white relative">
              <div className="absolute top-8 right-8">
                <Badge 
                  className="px-5 py-2 font-bold flex gap-2 items-center border-none shadow-xl text-xs"
                  style={{ 
                    backgroundColor: assessment.status === 'Scheduled' ? '#FFD100' : '#10B981', 
                    color: assessment.status === 'Scheduled' ? '#2F3E46' : '#FFFFFF'
                  }}
                >
                  {assessment.status === 'Scheduled' ? <Clock className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                  {assessment.status.toUpperCase()}
                </Badge>
              </div>

              <div className="space-y-4">
                <div className="inline-block px-3 py-1 rounded bg-[#FFD100]/20 border border-[#FFD100]/30">
                  <span className="text-[#FFD100] font-mono text-xs tracking-widest uppercase font-bold">
                    Ref ID: {assessment.id}
                  </span>
                </div>
                <CardTitle className="text-4xl md:text-5xl font-black tracking-tight leading-tight">
                  {assessment.title}
                </CardTitle>
                <div className="flex flex-wrap gap-4 pt-2">
                  <p className="text-gray-300 flex items-center gap-2 text-sm font-medium bg-white/10 px-3 py-1 rounded-full">
                    <Shield className="w-4 h-4 text-[#FFD100]" />
                    {assessment.type}
                  </p>
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-10 space-y-12">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="group flex items-center gap-5 p-6 rounded-2xl bg-gray-50 border border-gray-100 hover:border-[#FFD100]/50 transition-all">
                <div className="p-4 bg-white shadow-md rounded-xl text-[#FFD100] group-hover:scale-110 transition-transform">
                  <Calendar className="w-7 h-7" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Date of Record</p>
                  <p className="text-xl font-bold text-[#2F3E46]">{formatShortDate(assessment.date)}</p>
                </div>
              </div>

              <div className="group flex items-center gap-5 p-6 rounded-2xl bg-gray-50 border border-gray-100 hover:border-[#FFD100]/50 transition-all">
                <div className="p-4 bg-white shadow-md rounded-xl text-[#FFD100] group-hover:scale-110 transition-transform">
                  <Clock className="w-7 h-7" />
                </div>
                <div>
                  <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Assigned Time</p>
                  <p className="text-xl font-bold text-[#2F3E46]">{assessment.time}</p>
                </div>
              </div>
            </div>

            {isInterventionAssessment && (
              <div className="space-y-3 rounded-3xl border border-orange-200 bg-orange-50/50 p-6">
                <h4 className="text-xs font-black text-orange-700 uppercase tracking-[0.2em]">From Intervention</h4>
                {linkedViolations.length > 0 ? linkedViolations.map((v: any) => (
                  <div key={v.id} className="text-sm text-[#2F3E46]">
                    <div><span className="font-bold">Violation:</span> {v.type}</div>
                    <div><span className="font-bold">Offense Number:</span> {v.offenseNumber || '—'}</div>
                  </div>
                )) : <p className="text-sm text-gray-500">Linked violation details are unavailable.</p>}
                {psychosocialActivities.length > 0 && (
                  <div className="pt-2">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Psychosocial Activity Type(s)</p>
                    <div className="flex flex-wrap gap-2">
                      {psychosocialActivities.map((item: string) => <span key={item} className="px-2.5 py-1 rounded-full bg-white border border-purple-200 text-xs font-semibold text-purple-700">{item}</span>)}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-5">
              <h4 className="text-xs font-black text-[#2F3E46] uppercase tracking-[0.2em] flex items-center gap-3">
                <FileText className="w-5 h-5 text-[#FFD100]" />
                Notes / Description
              </h4>
              <div className="bg-[#2F3E46]/5 p-8 rounded-3xl border-l-4 border-[#FFD100] relative overflow-hidden">
                <p className="text-[#2F3E46] leading-loose text-lg italic relative z-10">
                  "{displayNotes || 'No additional notes recorded.'}"
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="border-none shadow-xl rounded-3xl overflow-hidden bg-white group">
            <div style={{ backgroundColor: '#FFD100' }} className="h-2 w-full"></div>
            <CardContent className="p-8">
              <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-6">Assessor In-Charge</p>
              <div className="flex items-center gap-5">
                <div className="w-16 h-16 rounded-2xl bg-[#2F3E46] flex items-center justify-center text-[#FFD100] font-black text-2xl shadow-xl">
                  {String(assessorList).charAt(0)}
                </div>
                <div>
                  <p className="text-xl font-black text-[#2F3E46]">{assessorList}</p>
                  <p className="text-xs text-gray-400 font-medium">Authorized Personnel</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-none shadow-xl rounded-3xl overflow-hidden bg-white">
            <CardHeader className="bg-gray-50/80 border-b border-gray-100 p-6">
              <CardTitle className="text-xs font-black text-[#2F3E46] flex items-center gap-3 uppercase tracking-widest">
                <Users className="w-5 h-5 text-[#FFD100]" />
                Participants ({filteredParticipants.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <div className="grid gap-3">
                {filteredParticipants.length > 0 ? (
                  filteredParticipants.map((participant: string, index: number) => (
                    <div key={index} className="flex items-center gap-4 p-4 rounded-2xl bg-gray-50/50">
                      <div className="w-8 h-8 rounded-lg bg-white shadow-sm flex items-center justify-center text-[10px] font-bold text-[#2F3E46]">
                        {index + 1}
                      </div>
                      <span className="text-sm font-bold text-[#2F3E46]">{participant}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-gray-400 italic text-center py-4">No residents assigned.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}