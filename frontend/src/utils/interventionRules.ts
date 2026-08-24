// src/utils/interventionRules.ts

export interface Recommendation {
  task: string;
  trigger: string;
  priority: 'High' | 'Urgent' | 'Medium' | 'Low';
}

/**
 * Maps a violation type string to the most appropriate assessment type.
 * Used for auto-triggered assessments when a behavioral violation is recorded.
 */
export function getAssessmentTypeForViolation(violationType: string): {
  assessmentTitle: string;
  assessmentType: string;
  assessor: string;
} {
  const lower = violationType.toLowerCase();

  if (
    lower.includes('fight') ||
    lower.includes('assault') ||
    lower.includes('aggress') ||
    lower.includes('violence') ||
    lower.includes('attack') ||
    lower.includes('harm')
  ) {
    return {
      assessmentTitle: `Behavioral Risk Assessment (${violationType})`,
      assessmentType: 'Psychological Testing',
      assessor: 'Clinical Psychologist',
    };
  }

  if (
    lower.includes('theft') ||
    lower.includes('steal') ||
    lower.includes('rob') ||
    lower.includes('took') ||
    lower.includes('borrow without')
  ) {
    return {
      assessmentTitle: `Values Formation Assessment (${violationType})`,
      assessmentType: 'Social Case Study Report',
      assessor: 'Social Worker',
    };
  }

  if (
    lower.includes('drug') ||
    lower.includes('substance') ||
    lower.includes('alcohol') ||
    lower.includes('smoke') ||
    lower.includes('narcotic') ||
    lower.includes('vape')
  ) {
    return {
      assessmentTitle: `Substance Use Assessment (${violationType})`,
      assessmentType: 'Psychological Testing',
      assessor: 'Clinical Psychologist / Counselor',
    };
  }

  if (
    lower.includes('escape') ||
    lower.includes('runaway') ||
    lower.includes('awol') ||
    lower.includes('absent') ||
    lower.includes('flee')
  ) {
    return {
      assessmentTitle: `Discernment & Risk Assessment (${violationType})`,
      assessmentType: 'Discernment Assessment',
      assessor: 'Case Manager',
    };
  }

  if (
    lower.includes('disrespect') ||
    lower.includes('defy') ||
    lower.includes('disobey') ||
    lower.includes('insult') ||
    lower.includes('verbal')
  ) {
    return {
      assessmentTitle: `Behavioral Interview (${violationType})`,
      assessmentType: 'Interview',
      assessor: 'Social Worker',
    };
  }

  // Default fallback for all other violations
  return {
    assessmentTitle: `Behavioral Follow-up Assessment (${violationType})`,
    assessmentType: 'Interview',
    assessor: 'Social Worker',
  };
}

export const getAutomatedInterventions = (child: any): Recommendation[] => {
  const recommendations: Recommendation[] = [];

  const currentPhase = child.casePhase || '';
  const totalPoints =
    child.behavioralLogs?.reduce(
      (sum: number, log: any) => sum + log.points,
      0
    ) || 0;
  const caseType = (child.caseType || '').toLowerCase();
  const hasViolations =
    child.behavioralLogs && child.behavioralLogs.length > 0;

  // 1. PHASE RULES
  if (currentPhase.includes('Admission')) {
    recommendations.push({
      task: 'Initial Social Case Study Report',
      trigger: 'Phase Requirement: Admission',
      priority: 'High',
    });
  }

  // 2. BEHAVIOR & VIOLATION RULES (Automatic Assessment Trigger)
  if (hasViolations) {
    recommendations.push({
      task: 'Behavioral Progress Assessment',
      trigger: 'Automatic Trigger: New Violation Recorded',
      priority: totalPoints >= 5 ? 'High' : 'Medium',
    });
  }

  if (totalPoints >= 10) {
    recommendations.push({
      task: 'Urgent Disciplinary Committee Meeting',
      trigger: `Critical Alert: ${totalPoints} Violation Points`,
      priority: 'Urgent',
    });
  }

  // 3. CASE TYPE RULES
  if (caseType.includes('theft') || caseType.includes('steal')) {
    recommendations.push({
      task: 'Values Formation: Property & Honesty',
      trigger: 'Targeted Intervention: Theft Case',
      priority: 'Medium',
    });
  }

  if (caseType.includes('drug') || caseType.includes('substance')) {
    recommendations.push({
      task: 'Substance Use Counseling Session',
      trigger: 'Targeted Intervention: Drug-Related Case',
      priority: 'High',
    });
  }

  if (caseType.includes('assault') || caseType.includes('violence')) {
    recommendations.push({
      task: 'Anger Management Program Enrollment',
      trigger: 'Targeted Intervention: Assault/Violence Case',
      priority: 'High',
    });
  }

  return recommendations;
};
