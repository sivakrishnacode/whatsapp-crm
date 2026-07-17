/**
 * Admin subscription management page
 * Allows admins to view and manage user subscriptions
 */

"use client";

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useState, useEffect } from 'react';
import { toast } from 'sonner';

interface UserWithSubscription {
  id: string;
  email: string;
  full_name: string | null;
  subscription: {
    id: string;
    plan_name: string;
    plan_display_name: string;
    status: string;
    trial_end_at: string | null;
    payment_method: string;
  } | null;
}

export default function AdminSubscriptionsPage() {
  const { user, canEditSettings } = useAuth();
  const [users, setUsers] = useState<UserWithSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!canEditSettings) return;
    fetchUsers();
  }, [canEditSettings]);

  const fetchUsers = async () => {
    const supabase = createClient();
    setLoading(true);

    try {
      const { data: usersData, error: usersError } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .order('created_at', { ascending: false });

      if (usersError) throw usersError;

      // Fetch subscriptions for each user
      const usersWithSubs = await Promise.all(
        (usersData || []).map(async (profile) => {
          const { data: subData } = await supabase
            .rpc('get_user_subscription', { p_user_id: profile.id });

          return {
            ...profile,
            subscription: subData && subData.length > 0 ? subData[0] : null,
          };
        })
      );

      setUsers(usersWithSubs);
    } catch (error) {
      console.error('Error fetching users:', error);
      toast.error('Failed to load subscriptions');
    } finally {
      setLoading(false);
    }
  };

  const filteredUsers = users.filter(
    (u) =>
      u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (u.full_name && u.full_name.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-500';
      case 'trial':
        return 'bg-blue-500';
      case 'past_due':
        return 'bg-yellow-500';
      case 'cancelled':
        return 'bg-red-500';
      case 'expired':
        return 'bg-gray-500';
      default:
        return 'bg-gray-500';
    }
  };

  const handleManualPlanChange = async (userId: string, currentPlan: string) => {
    // Placeholder for manual plan assignment
    // This will open a dialog to select a new plan
    toast.info('Manual plan assignment dialog coming soon');
  };

  if (!canEditSettings) {
    return (
      <div className="container mx-auto py-10 px-4">
        <Card>
          <CardHeader>
            <CardTitle>Access Denied</CardTitle>
            <CardDescription>You need admin privileges to view this page.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-10 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Subscription Management</h1>
          <p className="text-muted-foreground">View and manage user subscriptions</p>
        </div>

        <div className="mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by email or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 max-w-md"
            />
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>User Subscriptions</CardTitle>
            <CardDescription>
              {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''} found
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-4 font-medium">User</th>
                    <th className="text-left p-4 font-medium">Plan</th>
                    <th className="text-left p-4 font-medium">Status</th>
                    <th className="text-left p-4 font-medium">Payment Method</th>
                    <th className="text-left p-4 font-medium">Trial Ends</th>
                    <th className="text-left p-4 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((userWithSub) => (
                    <tr key={userWithSub.id} className="border-b hover:bg-muted/50">
                      <td className="p-4">
                        <div>
                          <div className="font-medium">{userWithSub.full_name || 'Unknown'}</div>
                          <div className="text-sm text-muted-foreground">{userWithSub.email}</div>
                        </div>
                      </td>
                      <td className="p-4">
                        {userWithSub.subscription ? (
                          <Badge variant="outline">{userWithSub.subscription.plan_display_name}</Badge>
                        ) : (
                          <span className="text-muted-foreground">No subscription</span>
                        )}
                      </td>
                      <td className="p-4">
                        {userWithSub.subscription ? (
                          <Badge className={getStatusColor(userWithSub.subscription.status)}>
                            {userWithSub.subscription.status}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="p-4">
                        {userWithSub.subscription ? (
                          <Badge variant="secondary">{userWithSub.subscription.payment_method}</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="p-4">
                        {userWithSub.subscription?.trial_end_at ? (
                          <span className="text-sm">
                            {new Date(userWithSub.subscription.trial_end_at).toLocaleDateString()}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="p-4">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            handleManualPlanChange(
                              userWithSub.id,
                              userWithSub.subscription?.plan_name || 'FREE'
                            )
                          }
                        >
                          Change Plan
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {filteredUsers.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-muted-foreground">
                        No users found matching your search
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
