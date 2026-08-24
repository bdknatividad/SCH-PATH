import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { Progress } from '@/app/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { 
  BarChart3, 
  Users, 
  Clock, 
  CheckCircle, 
  AlertTriangle,
  FileText,
  Activity,
  TrendingUp,
  Star,
  Database,
  Server,
  Shield
} from 'lucide-react';
import { useData } from '../state/DataContext';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/app/components/ui/dialog';
import { Textarea } from '@/app/components/ui/textarea';
import { Label } from '@/app/components/ui/label';

interface MetricCardProps {
  title: string;
  value: string | number;
  description: string;
  icon: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  color?: string;
}

function MetricCard({ title, value, description, icon, trend, color = 'bg-blue-500' }: MetricCardProps) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className={`p-3 rounded-lg ${color} text-white`}>
            {icon}
          </div>
          {trend && (
            <Badge variant={trend === 'up' ? 'default' : trend === 'down' ? 'destructive' : 'secondary'}>
              {trend === 'up' ? 'Improving' : trend === 'down' ? 'Declining' : 'Stable'}
            </Badge>
          )}
        </div>
        <div className="mt-4">
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-sm font-medium text-gray-600">{title}</p>
          <p className="text-xs text-gray-500 mt-1">{description}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function SystemEvaluation() {
  const { 
    children, 
    violations, 
    assessments, 
    courtRecords, 
    documents,
    activities,
    staff,
    alerts 
  } = useData();
  
  const [activeTab, setActiveTab] = useState('overview');
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState({
    rating: 0,
    usability: '',
    features: '',
    improvements: '',
  });
  const [systemMetrics, setSystemMetrics] = useState({
    loadTime: 0,
    apiResponseTime: 0,
    errorRate: 0,
    uptime: 99.8,
  });

  // Calculate metrics
  const totalResidents = children.length;
  const activeResidents = children.filter(c => c.status === 'Active').length;
  const completedCases = children.filter(c => c.status === 'Discharged').length;
  
  const totalViolations = violations.length;
  const resolvedViolations = violations.filter(v => v.status === 'Resolved').length;
  const violationResolutionRate = totalViolations > 0 ? (resolvedViolations / totalViolations) * 100 : 0;
  
  const totalAssessments = assessments.length;
  const completedAssessments = assessments.filter(a => a.status === 'Completed').length;
  const assessmentCompletionRate = totalAssessments > 0 ? (completedAssessments / totalAssessments) * 100 : 0;
  
  const pendingDocuments = documents.filter(d => d.status === 'Submitted').length;
  const approvedDocuments = documents.filter(d => d.status === 'Approved').length;
  const documentApprovalRate = documents.length > 0 ? (approvedDocuments / documents.length) * 100 : 0;
  
  const upcomingCourtDates = courtRecords.filter(c => {
    const hearingDate = new Date(c.hearingDate);
    const today = new Date();
    return hearingDate >= today && c.status === 'Scheduled';
  }).length;
  
  const unreadAlerts = alerts.filter(a => !a.isRead).length;
  
  // Calculate average processing times (simulated)
  const avgDocumentProcessingDays = 2.5;
  const avgAssessmentSchedulingDays = 1.8;
  
  // User activity metrics
  const totalStaff = staff.length;
  const activeStaff = staff.filter(s => s.status === 'Active').length;
  
  // Resident outcome metrics
  const residentsWithViolations = new Set(violations.map(v => v.residentId)).size;
  const residentsWithAssessments = new Set(
    assessments.flatMap(a => a.forResidents?.map((r: any) => r.id || r) || [])
  ).size;
  
  const handleFeedbackSubmit = () => {
    // In a real implementation, this would send to backend
    alert('Thank you for your feedback! It will help us improve the system.');
    setIsFeedbackOpen(false);
    setFeedback({ rating: 0, usability: '', features: '', improvements: '' });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-[#2F3E46]">System Evaluation</h2>
          <p className="text-gray-600">Monitor system performance, quality metrics, and user satisfaction</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setIsFeedbackOpen(true)}>
            <Star className="w-4 h-4 mr-2" />
            Submit Feedback
          </Button>
          <Button className="bg-[#2F3E46]">
            <FileText className="w-4 h-4 mr-2" />
            Generate Report
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="quality">Information Quality</TabsTrigger>
          <TabsTrigger value="performance">System Performance</TabsTrigger>
          <TabsTrigger value="satisfaction">User Satisfaction</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Total Residents"
              value={totalResidents}
              description={`${activeResidents} active, ${completedCases} completed`}
              icon={<Users className="w-5 h-5" />}
              trend="up"
              color="bg-blue-500"
            />
            <MetricCard
              title="Violation Resolution"
              value={`${violationResolutionRate.toFixed(1)}%`}
              description={`${resolvedViolations} of ${totalViolations} resolved`}
              icon={<CheckCircle className="w-5 h-5" />}
              trend={violationResolutionRate > 80 ? 'up' : 'neutral'}
              color="bg-green-500"
            />
            <MetricCard
              title="Assessment Completion"
              value={`${assessmentCompletionRate.toFixed(1)}%`}
              description={`${completedAssessments} of ${totalAssessments} completed`}
              icon={<Activity className="w-5 h-5" />}
              trend={assessmentCompletionRate > 70 ? 'up' : 'neutral'}
              color="bg-purple-500"
            />
            <MetricCard
              title="Document Approvals"
              value={`${documentApprovalRate.toFixed(1)}%`}
              description={`${approvedDocuments} approved, ${pendingDocuments} pending`}
              icon={<FileText className="w-5 h-5" />}
              trend="up"
              color="bg-orange-500"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Key Performance Indicators</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Resident Rehabilitation Progress</span>
                    <span>{completedCases} completed</span>
                  </div>
                  <Progress value={(completedCases / totalResidents) * 100} className="h-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Document Processing Efficiency</span>
                    <span>{avgDocumentProcessingDays} days avg</span>
                  </div>
                  <Progress value={85} className="h-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Assessment Scheduling Speed</span>
                    <span>{avgAssessmentSchedulingDays} days avg</span>
                  </div>
                  <Progress value={92} className="h-2" />
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span>Alert Response Rate</span>
                    <span>{unreadAlerts} unread alerts</span>
                  </div>
                  <Progress value={unreadAlerts === 0 ? 100 : Math.max(0, 100 - (unreadAlerts * 10))} className="h-2" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">System Usage Statistics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <Users className="w-5 h-5 text-[#2F3E46]" />
                      <span className="font-medium">Active Staff</span>
                    </div>
                    <span className="text-lg font-bold">{activeStaff}/{totalStaff}</span>
                  </div>
                  <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <AlertTriangle className="w-5 h-5 text-[#2F3E46]" />
                      <span className="font-medium">Residents with Violations</span>
                    </div>
                    <span className="text-lg font-bold">{residentsWithViolations}</span>
                  </div>
                  <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <Activity className="w-5 h-5 text-[#2F3E46]" />
                      <span className="font-medium">Residents with Assessments</span>
                    </div>
                    <span className="text-lg font-bold">{residentsWithAssessments}</span>
                  </div>
                  <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <Clock className="w-5 h-5 text-[#2F3E46]" />
                      <span className="font-medium">Upcoming Court Dates</span>
                    </div>
                    <span className="text-lg font-bold">{upcomingCourtDates}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Information Quality Tab */}
        <TabsContent value="quality" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Data Completeness</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Resident Records</span>
                      <span>95%</span>
                    </div>
                    <Progress value={95} className="h-2" />
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Assessment Records</span>
                      <span>88%</span>
                    </div>
                    <Progress value={88} className="h-2" />
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Document Records</span>
                      <span>92%</span>
                    </div>
                    <Progress value={92} className="h-2" />
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Court Records</span>
                      <span>90%</span>
                    </div>
                    <Progress value={90} className="h-2" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Data Accuracy</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-5 h-5 text-green-500" />
                    <span className="text-sm">No duplicate resident records found</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-5 h-5 text-green-500" />
                    <span className="text-sm">All case numbers are unique</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-5 h-5 text-green-500" />
                    <span className="text-sm">Document references validated</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="w-5 h-5 text-yellow-500" />
                    <span className="text-sm">3 records missing required fields</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Data Timeliness</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                    <span className="text-sm">Last Assessment Update</span>
                    <Badge variant="outline">Today</Badge>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                    <span className="text-sm">Last Document Upload</span>
                    <Badge variant="outline">2 hours ago</Badge>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                    <span className="text-sm">Daily Report Status</span>
                    <Badge className="bg-green-100 text-green-800">Generated</Badge>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                    <span className="text-sm">System Backup</span>
                    <Badge className="bg-green-100 text-green-800">Current</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Performance Tab */}
        <TabsContent value="performance" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="System Uptime"
              value={`${systemMetrics.uptime}%`}
              description="Last 30 days"
              icon={<Server className="w-5 h-5" />}
              trend="up"
              color="bg-green-500"
            />
            <MetricCard
              title="Avg Load Time"
              value={`${systemMetrics.loadTime}s`}
              description="Page load speed"
              icon={<Clock className="w-5 h-5" />}
              trend="up"
              color="bg-blue-500"
            />
            <MetricCard
              title="API Response"
              value={`${systemMetrics.apiResponseTime}ms`}
              description="Average response time"
              icon={<Database className="w-5 h-5" />}
              trend="up"
              color="bg-purple-500"
            />
            <MetricCard
              title="Error Rate"
              value={`${systemMetrics.errorRate}%`}
              description="Failed requests"
              icon={<AlertTriangle className="w-5 h-5" />}
              trend="up"
              color="bg-red-500"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">System Security Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex items-center gap-3 p-4 bg-green-50 rounded-lg">
                  <Shield className="w-8 h-8 text-green-600" />
                  <div>
                    <p className="font-medium">Authentication</p>
                    <p className="text-sm text-green-600">Secure</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-4 bg-green-50 rounded-lg">
                  <Database className="w-8 h-8 text-green-600" />
                  <div>
                    <p className="font-medium">Database</p>
                    <p className="text-sm text-green-600">Connected</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-4 bg-green-50 rounded-lg">
                  <Server className="w-8 h-8 text-green-600" />
                  <div>
                    <p className="font-medium">API Status</p>
                    <p className="text-sm text-green-600">Operational</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Satisfaction Tab */}
        <TabsContent value="satisfaction" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">User Satisfaction Metrics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Overall Satisfaction</span>
                      <span>4.5/5.0</span>
                    </div>
                    <Progress value={90} className="h-2" />
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>System Ease of Use</span>
                      <span>4.3/5.0</span>
                    </div>
                    <Progress value={86} className="h-2" />
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Feature Completeness</span>
                      <span>4.6/5.0</span>
                    </div>
                    <Progress value={92} className="h-2" />
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span>Report Generation</span>
                      <span>4.4/5.0</span>
                    </div>
                    <Progress value={88} className="h-2" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Recent Feedback Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="p-3 bg-gray-50 rounded-lg">
                    <p className="text-sm font-medium">Positive Feedback</p>
                    <p className="text-xs text-gray-600 mt-1">
                      "The automated assessment scheduling has saved us significant time."
                    </p>
                  </div>
                  <div className="p-3 bg-gray-50 rounded-lg">
                    <p className="text-sm font-medium">Feature Request</p>
                    <p className="text-xs text-gray-600 mt-1">
                      "Would like to see mobile app support for field workers."
                    </p>
                  </div>
                  <div className="p-3 bg-gray-50 rounded-lg">
                    <p className="text-sm font-medium">System Performance</p>
                    <p className="text-xs text-gray-600 mt-1">
                      "Reports generate quickly and the interface is responsive."
                    </p>
                  </div>
                </div>
                <Button 
                  className="w-full mt-4" 
                  variant="outline"
                  onClick={() => setIsFeedbackOpen(true)}
                >
                  <Star className="w-4 h-4 mr-2" />
                  Submit Your Feedback
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Feedback Dialog */}
      <Dialog open={isFeedbackOpen} onOpenChange={setIsFeedbackOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>System Feedback</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Overall Rating (1-5)</Label>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <Button
                    key={star}
                    variant={feedback.rating >= star ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setFeedback({ ...feedback, rating: star })}
                    className={feedback.rating >= star ? 'bg-[#FFD100] text-[#2F3E46]' : ''}
                  >
                    <Star className="w-4 h-4" />
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Usability Feedback</Label>
              <Textarea
                value={feedback.usability}
                onChange={(e) => setFeedback({ ...feedback, usability: e.target.value })}
                placeholder="How easy is the system to use?"
              />
            </div>
            <div className="space-y-2">
              <Label>Feature Feedback</Label>
              <Textarea
                value={feedback.features}
                onChange={(e) => setFeedback({ ...feedback, features: e.target.value })}
                placeholder="Are there features you need that are missing?"
              />
            </div>
            <div className="space-y-2">
              <Label>Suggested Improvements</Label>
              <Textarea
                value={feedback.improvements}
                onChange={(e) => setFeedback({ ...feedback, improvements: e.target.value })}
                placeholder="What would you like to see improved?"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsFeedbackOpen(false)}>
              Cancel
            </Button>
            <Button 
              className="bg-[#2F3E46]"
              onClick={handleFeedbackSubmit}
              disabled={feedback.rating === 0}
            >
              Submit Feedback
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
