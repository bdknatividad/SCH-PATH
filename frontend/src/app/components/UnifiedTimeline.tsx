import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { 
  User, 
  FileText, 
  Activity, 
  AlertTriangle, 
  Gavel, 
  GraduationCap,
  Clock,
  CheckCircle,
  XCircle
} from 'lucide-react';
import { useData } from '../state/DataContext';

interface UnifiedTimelineProps {
  residentId: string;
}

interface TimelineEvent {
  id: string;
  date: string;
  time?: string;
  type: 'admission' | 'phase' | 'violation' | 'assessment' | 'court' | 'medical' | 'activity' | 'document';
  title: string;
  description?: string;
  status?: string;
  icon: React.ReactNode;
  color: string;
}

export function UnifiedTimeline({ residentId }: UnifiedTimelineProps) {
  const { 
    children, 
    phaseProgress, 
    violations, 
    assessments, 
    courtRecords,
    activities,
    documents 
  } = useData();

  const resident = children.find(c => c.id === residentId);

  const timelineEvents = useMemo(() => {
    const events: TimelineEvent[] = [];

    // Admission event
    if (resident?.admissionDate) {
      events.push({
        id: 'admission',
        date: resident.admissionDate,
        type: 'admission',
        title: 'Resident Admission',
        description: `Admitted to Second Chance Home. Case type: ${resident.caseType || 'N/A'}`,
        icon: <User className="w-4 h-4" />,
        color: 'bg-blue-500',
      });
    }

    // Phase progression events
    phaseProgress
      .filter(p => p.residentId === residentId)
      .forEach(phase => {
        events.push({
          id: phase.id,
          date: phase.enteredAt,
          type: 'phase',
          title: `Entered ${phase.phaseName} Phase`,
          description: phase.notes || 'Phase progression recorded',
          status: phase.isCurrent ? 'Current' : phase.completedAt ? 'Completed' : 'In Progress',
          icon: <Activity className="w-4 h-4" />,
          color: phase.isCurrent ? 'bg-green-500' : 'bg-gray-500',
        });
      });

    // Violation events
    violations
      .filter(v => v.residentId === residentId)
      .forEach(violation => {
        events.push({
          id: violation.id,
          date: violation.date,
          type: 'violation',
          title: `Violation: ${violation.type}`,
          description: `${violation.description || 'No details'} (${violation.points} points)`,
          status: violation.status,
          icon: <AlertTriangle className="w-4 h-4" />,
          color: violation.severity === 'Critical' ? 'bg-red-500' : violation.severity === 'Major' ? 'bg-orange-500' : 'bg-yellow-500',
        });
      });

    // Assessment events
    assessments
      .filter(a => a.forResidents?.some((r: any) => r.id === residentId || r === residentId))
      .forEach(assessment => {
        events.push({
          id: assessment.id,
          date: assessment.date,
          time: assessment.time,
          type: 'assessment',
          title: `Assessment: ${assessment.title}`,
          description: `Type: ${assessment.type} | Assessor: ${assessment.assessor}`,
          status: assessment.status,
          icon: <FileText className="w-4 h-4" />,
          color: assessment.status === 'Completed' ? 'bg-green-500' : 'bg-blue-500',
        });
      });

    // Court record events
    courtRecords
      .filter(c => c.residentId === residentId)
      .forEach(court => {
        events.push({
          id: court.id,
          date: court.hearingDate,
          time: court.hearingTime,
          type: 'court',
          title: `Court Hearing: ${court.caseNumber || 'N/A'}`,
          description: `${court.hearingType || 'Hearing'} at ${court.courtName || 'Unknown Court'}`,
          status: court.status,
          icon: <Gavel className="w-4 h-4" />,
          color: court.status === 'Completed' ? 'bg-green-500' : 'bg-purple-500',
        });
      });

    // Activity events
    activities
      .filter(a => a.selectedResidentIds?.includes(residentId))
      .forEach(activity => {
        events.push({
          id: activity.id,
          date: activity.date,
          time: activity.time,
          type: 'activity',
          title: `Activity: ${activity.title}`,
          description: `${activity.category || 'Activity'} | ${activity.location || 'No location'}`,
          status: activity.status,
          icon: <GraduationCap className="w-4 h-4" />,
          color: 'bg-indigo-500',
        });
      });

    // Document events
    documents
      .filter(d => d.residentId === residentId && d.status === 'Approved')
      .forEach(doc => {
        events.push({
          id: doc.id,
          date: doc.uploadedAt || doc.submittedAt || '',
          type: 'document',
          title: `Document: ${doc.title}`,
          description: `${doc.category || 'Document'} approved`,
          status: 'Approved',
          icon: <FileText className="w-4 h-4" />,
          color: 'bg-cyan-500',
        });
      });

    // Sort by date (newest first)
    return events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [resident, phaseProgress, violations, assessments, courtRecords, activities, documents, residentId]);

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'admission': return 'Admission';
      case 'phase': return 'Phase';
      case 'violation': return 'Violation';
      case 'assessment': return 'Assessment';
      case 'court': return 'Court';
      case 'activity': return 'Activity';
      case 'document': return 'Document';
      default: return type;
    }
  };

  const getStatusBadge = (status?: string) => {
    if (!status) return null;
    
    switch (status.toLowerCase()) {
      case 'completed':
      case 'approved':
        return <Badge className="bg-green-100 text-green-800 text-xs">{status}</Badge>;
      case 'current':
      case 'active':
      case 'scheduled':
        return <Badge className="bg-blue-100 text-blue-800 text-xs">{status}</Badge>;
      case 'pending':
      case 'pending review':
      case 'submitted':
        return <Badge className="bg-yellow-100 text-yellow-800 text-xs">{status}</Badge>;
      case 'resolved':
        return <Badge className="bg-green-100 text-green-800 text-xs">{status}</Badge>;
      case 'escalated':
      case 'critical':
        return <Badge className="bg-red-100 text-red-800 text-xs">{status}</Badge>;
      default:
        return <Badge className="bg-gray-100 text-gray-800 text-xs">{status}</Badge>;
    }
  };

  if (timelineEvents.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-gray-500">No timeline events recorded for this resident.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-l-4 border-l-[#2F3E46]">
      <CardHeader>
        <CardTitle className="text-lg">Resident Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />

          <div className="space-y-4">
            {timelineEvents.map((event, index) => (
              <div key={event.id} className="relative flex gap-4">
                {/* Timeline dot */}
                <div className={`relative z-10 w-8 h-8 rounded-full ${event.color} flex items-center justify-center text-white shrink-0`}>
                  {event.icon}
                </div>

                {/* Event content */}
                <div className="flex-1 pb-4">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-xs">
                      {getTypeLabel(event.type)}
                    </Badge>
                    <span className="text-sm text-gray-500">
                      {new Date(event.date).toLocaleDateString('en-PH', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                      {event.time && ` at ${event.time}`}
                    </span>
                    {getStatusBadge(event.status)}
                  </div>
                  <h4 className="font-medium text-[#2F3E46]">{event.title}</h4>
                  {event.description && (
                    <p className="text-sm text-gray-600 mt-1">{event.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
