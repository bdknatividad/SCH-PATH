import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent } from '@/app/components/ui/card';
import { Label } from '@/app/components/ui/label';
import { Textarea } from '@/app/components/ui/textarea';
import { Heart, ArrowLeft, Star, Send } from 'lucide-react';
import { useData } from '../state/DataContext';
import { createResource, describeError } from '@/services/api';
import { systemDialog } from '@/app/components/SystemDialog';

export default function EvaluationForm() {
  const { id, residentId } = useParams();
  const navigate = useNavigate();
  const { activities, children: allChildren } = useData();

  const [residentName, setResidentName] = useState('');
  const [activityTitle, setActivityTitle] = useState('');
  const [rating, setRating] = useState(0);
  const [remarks, setRemarks] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const child = allChildren.find(c => c.id === residentId);
    if (child) setResidentName(child.name);

    const activity = activities.find((a: any) => a.id === id);
    if (activity) setActivityTitle(activity.title);
  }, [id, residentId, activities, allChildren]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (rating === 0) {
      void systemDialog.validation('Select a rating before submitting', {
        description: 'Pick one of the rating faces — that is the whole point of the evaluation.',
      });
      return;
    }

    setIsSubmitting(true);

    const evaluationData = {
      id: `EVAL${Date.now()}`,
      activityId: id,
      residentId: residentId,
      residentName: residentName,
      rating: rating,
      remarks: remarks,
      dateEvaluated: new Date().toISOString()
    };

    try {
      await createResource('activityEvaluations', evaluationData);
      await systemDialog.success('Evaluation saved.', `The rating for ${residentName} has been recorded.`);
      setIsSubmitting(false);
      navigate(`/activities/${id}`);
      return;
    } catch (error) {
      // Do not claim the evaluation was stored — nothing is written locally,
      // so a failed request means the rating is lost. The form stays open so the
      // rating is not thrown away by a redirect.
      await systemDialog.failure(
        'Could not save the evaluation',
        describeError(error, `The rating for ${residentName} was not saved. Please try again.`),
      );
    }
    setIsSubmitting(false);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button 
          variant="ghost" 
          onClick={() => navigate(`/activities/${id}`)} 
          className="gap-2 text-gray-500 hover:text-[#2F3E46] hover:bg-gray-100"
        >
          <ArrowLeft size={16} /> Cancel and Go Back
        </Button>
      </div>

      {/* Hero Header */}
      <div className="text-center space-y-3 py-4">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#2F3E46] text-white mb-2 shadow-xl ring-4 ring-[#2F3E46]/10">
          <Heart size={28} fill="currentColor" />
        </div>
        <h1 className="text-3xl font-black text-[#2F3E46] tracking-tight">Participant Evaluation</h1>
        <p className="text-gray-400 text-sm max-w-sm mx-auto">Please provide honest feedback regarding the resident's engagement in the activity.</p>
      </div>

      {/* Info Card */}
      <Card className="overflow-hidden border-none shadow-lg bg-white ring-1 ring-black/5">
        <div className="flex flex-col sm:flex-row">
          <div className="bg-[#2F3E46] sm:w-32 flex flex-col items-center justify-center text-white p-6 gap-2">
            <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center backdrop-blur-sm">
               <Star size={24} className="text-yellow-400" fill="currentColor" />
            </div>
            <span className="text-[10px] uppercase font-black tracking-widest text-center opacity-70">Focus Record</span>
          </div>
          <CardContent className="p-8 flex-1">
             <div className="inline-flex px-3 py-1 rounded-md bg-blue-50 text-[#2F3E46] text-[11px] font-black mb-3 uppercase tracking-tighter ring-1 ring-blue-100">
                {activityTitle || "ACTIVITY RECORD"}
             </div>
             <h2 className="text-3xl font-black text-gray-900 tracking-tight">{residentName || "Select Resident"}</h2>
             <p className="text-xs text-gray-400 font-mono mt-2 flex items-center gap-2">
               <span className="bg-gray-100 px-2 py-0.5 rounded">SYSTEM ID: {residentId}</span>
             </p>
          </CardContent>
        </div>
      </Card>

      {/* Form Section */}
      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="border-none shadow-md ring-1 ring-black/5">
          <CardContent className="p-8 space-y-10">
            
            {/* Rating Section */}
            <div className="space-y-6">
              <Label className="text-xl font-black text-[#2F3E46] flex items-center gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-[#2F3E46] text-white text-sm">1</span>
                How was the engagement?
              </Label>
              
              <div className="grid grid-cols-5 gap-2 px-2">
                {[1, 2, 3, 4, 5].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => setRating(num)}
                    className={`flex flex-col items-center gap-3 py-4 rounded-2xl transition-all duration-300 ${
                      rating === num 
                      ? 'bg-[#2F3E46]/5 border-2 border-[#2F3E46] scale-105 shadow-sm' 
                      : 'border-2 border-transparent opacity-40 grayscale hover:opacity-100 hover:grayscale-0 hover:bg-gray-50'
                    }`}
                  >
                    <span className="text-4xl sm:text-5xl">
                      {num === 1 && '🙁'}
                      {num === 2 && '😐'}
                      {num === 3 && '🙂'}
                      {num === 4 && '😊'}
                      {num === 5 && '🤩'}
                    </span>
                    <span className={`text-[10px] font-black uppercase tracking-tighter ${rating === num ? 'text-[#2F3E46]' : 'text-gray-400'}`}>
                      {num === 1 && 'Poor'}
                      {num === 2 && 'Fair'}
                      {num === 3 && 'Average'}
                      {num === 4 && 'Good'}
                      {num === 5 && 'Excellent'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Remarks Section */}
            <div className="space-y-4 border-t border-gray-50 pt-8">
              <Label className="text-xl font-black text-[#2F3E46] flex items-center gap-3">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-[#2F3E46] text-white text-sm">2</span>
                Observer Progress Notes
              </Label>
              <Textarea 
                placeholder="Type your detailed observations here. Mention specific behaviors, achievements, or areas for improvement..." 
                className="min-h-[180px] bg-gray-50/50 border-gray-200 focus:bg-white focus:ring-2 focus:ring-[#2F3E46]/20 transition-all text-base rounded-xl p-6 leading-relaxed"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                required
              />
            </div>
            
            {/* Action Buttons */}
            <div className="pt-4 flex flex-col gap-3">
              <Button 
                type="submit" 
                disabled={isSubmitting}
                className="w-full bg-[#2F3E46] hover:bg-[#2F3E46]/90 h-16 text-lg font-black shadow-xl rounded-xl gap-3 transition-all active:scale-[0.98]"
              >
                {isSubmitting ? (
                  "Processing Record..."
                ) : (
                  <>
                    <Send size={20} />
                    Submit Final Evaluation
                  </>
                )}
              </Button>
              <p className="text-center text-[10px] text-gray-400 font-medium uppercase tracking-widest">
                Double check information before submitting.
              </p>
            </div>

          </CardContent>
        </Card>
      </form>
    </div>
  );
}