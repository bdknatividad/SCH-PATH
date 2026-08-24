import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { CheckCircle, XCircle, Clock, FileText, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useData } from '../state/DataContext';

interface PhaseRequirementsProps {
  residentId: string;
  currentPhase: string;
}

interface ValidationResult {
  canProgress: boolean;
  currentPhase: string;
  daysInPhase: number;
  requirements: {
    documents: {
      required: string[];
      approved: string[];
      missing: string[];
      satisfied: boolean;
    };
    assessments: {
      required: string[];
      completed: string[];
      missing: string[];
      satisfied: boolean;
    };
    violations: {
      current: number;
      maxAllowed: number;
      satisfied: boolean;
    };
    duration: {
      current: number;
      required: number;
      satisfied: boolean;
    };
  };
  message: string;
}

export function PhaseRequirements({ residentId, currentPhase }: PhaseRequirementsProps) {
  const { validatePhaseProgress, documents, assessments, violations, phaseProgress } = useData();
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    checkRequirements();
  }, [residentId, currentPhase, documents, assessments, violations, phaseProgress]);

  const checkRequirements = async () => {
    setLoading(true);
    const result = await validatePhaseProgress(residentId);
    if (result) {
      setValidation(result);
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-gray-500">Checking phase requirements...</p>
        </CardContent>
      </Card>
    );
  }

  if (!validation) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-gray-500">Unable to load phase requirements.</p>
          <Button onClick={checkRequirements} className="mt-2" variant="outline" size="sm">
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { canProgress, daysInPhase, requirements, message } = validation;

  return (
    <Card className="border-l-4 border-l-[#2F3E46]">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-lg">Phase Progression Requirements</CardTitle>
            <Badge className={canProgress ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}>
              {canProgress ? 'Ready to Progress' : 'Requirements Pending'}
            </Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
        <p className="text-sm text-gray-500">{message}</p>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4">
          {/* Duration Status */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
            <Clock className="w-5 h-5 text-[#2F3E46]" />
            <div className="flex-1">
              <p className="font-medium text-sm">Time in Current Phase</p>
              <p className="text-xs text-gray-500">
                {daysInPhase} of {requirements.duration.required} days required
              </p>
            </div>
            {requirements.duration.satisfied ? (
              <CheckCircle className="w-5 h-5 text-green-500" />
            ) : (
              <XCircle className="w-5 h-5 text-red-500" />
            )}
          </div>

          {/* Documents Status */}
          <div className="border rounded-lg overflow-hidden">
            <div 
              className={`flex items-center gap-3 p-3 ${requirements.documents.satisfied ? 'bg-green-50' : 'bg-yellow-50'}`}
            >
              <FileText className="w-5 h-5 text-[#2F3E46]" />
              <div className="flex-1">
                <p className="font-medium text-sm">Required Documents</p>
                <p className="text-xs text-gray-500">
                  {requirements.documents.approved.length} of {requirements.documents.required.length} completed
                </p>
              </div>
              {requirements.documents.satisfied ? (
                <CheckCircle className="w-5 h-5 text-green-500" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-yellow-500" />
              )}
            </div>
            {requirements.documents.missing.length > 0 && (
              <div className="p-3 bg-white border-t">
                <p className="text-xs font-medium text-red-600 mb-2">Missing Documents:</p>
                <ul className="space-y-1">
                  {requirements.documents.missing.map((doc, idx) => (
                    <li key={idx} className="text-xs text-gray-600 flex items-center gap-2">
                      <XCircle className="w-3 h-3 text-red-400" />
                      {doc}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Assessments Status */}
          {requirements.assessments.required.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <div 
                className={`flex items-center gap-3 p-3 ${requirements.assessments.satisfied ? 'bg-green-50' : 'bg-yellow-50'}`}
              >
                <Clock className="w-5 h-5 text-[#2F3E46]" />
                <div className="flex-1">
                  <p className="font-medium text-sm">Required Assessments</p>
                  <p className="text-xs text-gray-500">
                    {requirements.assessments.completed.length} of {requirements.assessments.required.length} completed
                  </p>
                </div>
                {requirements.assessments.satisfied ? (
                  <CheckCircle className="w-5 h-5 text-green-500" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-yellow-500" />
                )}
              </div>
              {requirements.assessments.missing.length > 0 && (
                <div className="p-3 bg-white border-t">
                  <p className="text-xs font-medium text-red-600 mb-2">Pending Assessments:</p>
                  <ul className="space-y-1">
                    {requirements.assessments.missing.map((assessment, idx) => (
                      <li key={idx} className="text-xs text-gray-600 flex items-center gap-2">
                        <XCircle className="w-3 h-3 text-red-400" />
                        {assessment}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Violations Status */}
          <div className={`flex items-center gap-3 p-3 rounded-lg ${requirements.violations.satisfied ? 'bg-green-50' : 'bg-red-50'}`}>
            <AlertTriangle className="w-5 h-5 text-[#2F3E46]" />
            <div className="flex-1">
              <p className="font-medium text-sm">Violation Status</p>
              <p className="text-xs text-gray-500">
                {requirements.violations.current} active (max allowed: {requirements.violations.maxAllowed})
              </p>
            </div>
            {requirements.violations.satisfied ? (
              <CheckCircle className="w-5 h-5 text-green-500" />
            ) : (
              <XCircle className="w-5 h-5 text-red-500" />
            )}
          </div>

          {/* Progress Action */}
          {canProgress && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm text-green-800 font-medium">
                All requirements met! This resident is ready to progress to the next phase.
              </p>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
