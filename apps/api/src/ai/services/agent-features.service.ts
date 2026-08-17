import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ============================================================
 * AI feature analysis service.
 *
 * Provides conversation analysis: sentiment, contact scoring,
 * auto-actions, and conversation summaries.
 * Uses heuristic analysis and can be enhanced with ML models.
 * ============================================================
 */

export interface SentimentAnalysisResult {
  sentiment: 'positive' | 'negative' | 'neutral';
  confidence: number; // 0-100
  reasoning: string;
}

export interface ContactScoreResult {
  score: number; // 0-100
  level: 'low' | 'medium' | 'high';
  factors: string[];
}

export interface AutoActionRecommendation {
  type: string;
  description: string;
  confidence: number;
  parameters?: Record<string, unknown>;
}

export interface ConversationSummaryResult {
  summary: string;
  keyPoints: string[];
  sentiment: 'positive' | 'negative' | 'neutral';
  suggestedFollowUp?: string;
}

@Injectable()
export class AgentFeaturesService {
  private readonly logger = new Logger(AgentFeaturesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Analyze sentiment from a message thread.
   * Uses keyword-based heuristic analysis (can be upgraded to ML model).
   */
  analyzeSentiment(messageText: string): SentimentAnalysisResult {
    if (!messageText?.trim()) {
      return {
        sentiment: 'neutral',
        confidence: 0.5,
        reasoning: 'No message provided.',
      };
    }

    const text = messageText.toLowerCase();

    // Positive sentiment indicators
    const positiveWords = [
      'thank',
      'great',
      'excellent',
      'good',
      'love',
      'awesome',
      'perfect',
      'happy',
      'satisfied',
      'brilliant',
      'amazing',
      'wonderful',
      'fantastic',
      'impressed',
      'excited',
      'pleased',
    ];

    // Negative sentiment indicators
    const negativeWords = [
      'bad',
      'terrible',
      'awful',
      'hate',
      'angry',
      'disappointed',
      'upset',
      'frustrated',
      'complaint',
      'problem',
      'issue',
      'broken',
      'useless',
      'worse',
      'disgusted',
      'unhappy',
      'wrong',
      'failed',
    ];

    const positiveCount = positiveWords.filter((w) => text.includes(w)).length;
    const negativeCount = negativeWords.filter((w) => text.includes(w)).length;

    let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';
    let confidence = 0.5;

    if (positiveCount > negativeCount) {
      sentiment = 'positive';
      confidence = Math.min(0.95, 0.5 + positiveCount * 0.15);
    } else if (negativeCount > positiveCount) {
      sentiment = 'negative';
      confidence = Math.min(0.95, 0.5 + negativeCount * 0.15);
    } else if (positiveCount + negativeCount > 0) {
      sentiment = 'neutral';
      confidence = 0.6;
    }

    return {
      sentiment,
      confidence,
      reasoning: `Found ${positiveCount} positive and ${negativeCount} negative indicators.`,
    };
  }

  /**
   * Score a contact's engagement level (0-100) based on conversation data.
   * In production, this would combine DB queries with the sentiment analysis.
   */
  async scoreContact(
    contactId: string,
    accountId: string,
  ): Promise<ContactScoreResult> {
    if (!contactId) {
      return {
        score: 0,
        level: 'low',
        factors: ['No contact ID provided'],
      };
    }

    try {
      const contact = await this.prisma.contacts.findFirst({
        where: { id: contactId, account_id: accountId },
        select: { id: true, created_at: true },
      });

      if (!contact) {
        return {
          score: 0,
          level: 'low',
          factors: ['Contact not found'],
        };
      }

      // Get conversation and message counts through the relationship
      const conversations = await this.prisma.conversations.findMany({
        where: { contact_id: contactId },
        select: {
          id: true,
          created_at: true,
          messages: {
            select: { created_at: true },
          },
        },
      });

      const factors: string[] = [];
      let score = 0;

      // Factor 1: Number of conversations (0-25 points)
      const conversationCount = conversations.length;
      const conversationScore = Math.min(25, conversationCount * 3);
      score += conversationScore;
      if (conversationCount > 0) {
        factors.push(`${conversationCount} conversation(s)`);
      }

      // Factor 2: Message frequency (0-25 points)
      const totalMessages = conversations.reduce(
        (sum, conv) => sum + conv.messages.length,
        0,
      );
      const messageScore = Math.min(25, totalMessages * 0.5);
      score += messageScore;
      if (totalMessages > 0) {
        factors.push(`${totalMessages} message(s)`);
      }

      // Factor 3: Recency (0-25 points)
      const now = new Date();
      const timestamps = conversations
        .map((c) => (c.created_at ? new Date(c.created_at).getTime() : 0))
        .filter((t) => t > 0);
      const lastInteraction = timestamps.length > 0
        ? new Date(Math.max(...timestamps))
        : null;

      if (lastInteraction) {
        const daysSinceInteraction =
          (now.getTime() - lastInteraction.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceInteraction < 7) {
          score += 25;
          factors.push('Recently active');
        } else if (daysSinceInteraction < 30) {
          score += 15;
          factors.push('Active this month');
        } else if (daysSinceInteraction < 90) {
          score += 5;
          factors.push('Active this quarter');
        }
      }

      // Factor 4: Deal existence (0-25 points)
      const dealCount = await this.prisma.deals.count({
        where: { contact_id: contactId, status: 'open' },
      });

      if (dealCount > 0) {
        score += 25;
        factors.push(`${dealCount} open deal(s)`);
      }

      // Determine level
      let level: 'low' | 'medium' | 'high' = 'low';
      if (score >= 60) {
        level = 'high';
      } else if (score >= 30) {
        level = 'medium';
      }

      return {
        score: Math.min(100, Math.round(score)),
        level,
        factors,
      };
    } catch (error) {
      return {
        score: 0,
        level: 'low',
        factors: [
          error instanceof Error ? `Error: ${error.message}` : 'Failed to score contact',
        ],
      };
    }
  }

  /**
   * Recommend next actions based on conversation context.
   */
  getAutoActions(
    sentiment: 'positive' | 'negative' | 'neutral',
    contactScore: number,
    conversationContext?: string,
  ): AutoActionRecommendation[] {
    const recommendations: AutoActionRecommendation[] = [];

    // Negative sentiment → escalation
    if (sentiment === 'negative') {
      recommendations.push({
        type: 'escalate_to_human',
        description:
          'Customer appears upset or dissatisfied. Consider escalating to a human agent.',
        confidence: 0.9,
        parameters: { priority: 'high' },
      });
    }

    // High engagement score → nurture
    if (contactScore >= 70) {
      recommendations.push({
        type: 'nurture_relationship',
        description: 'Highly engaged customer. Consider a personalized follow-up or offer.',
        confidence: 0.75,
        parameters: { type: 'personalized_offer' },
      });
    }

    // Medium-high score with positive sentiment → upsell
    if (contactScore >= 50 && sentiment === 'positive') {
      recommendations.push({
        type: 'upsell_opportunity',
        description: 'Customer is satisfied and engaged. Consider suggesting complementary products.',
        confidence: 0.65,
        parameters: { type: 'recommendation' },
      });
    }

    // Low engagement → re-engagement
    if (contactScore < 30) {
      recommendations.push({
        type: 'reactivation_campaign',
        description: 'Low engagement detected. Consider a re-engagement campaign.',
        confidence: 0.6,
        parameters: { type: 'special_offer' },
      });
    }

    return recommendations;
  }

  /**
   * Generate a summary of a conversation.
   * Uses heuristic analysis (can be upgraded to use AI model).
   */
  summarizeConversation(
    messages: Array<{ role: string; text: string }>,
  ): ConversationSummaryResult {
    if (!messages || messages.length === 0) {
      return {
        summary: 'No messages to summarize.',
        keyPoints: [],
        sentiment: 'neutral',
      };
    }

    // Extract customer messages
    const customerMessages = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.text)
      .filter(Boolean);

    // Analyze overall sentiment
    const combinedText = customerMessages.join(' ');
    const sentimentResult = this.analyzeSentiment(combinedText);

    // Extract key points (longest customer messages and those with question marks)
    const keyPoints: string[] = [];
    for (const msg of customerMessages) {
      if (msg.length > 50 || msg.includes('?')) {
        keyPoints.push(msg.slice(0, 100));
      }
    }

    // Generate summary
    let summary = '';
    if (customerMessages.length === 0) {
      summary = 'Empty conversation.';
    } else if (customerMessages.length === 1) {
      summary = `Customer message: "${customerMessages[0]?.slice(0, 150)}"`;
    } else {
      const firstMsg = customerMessages[0]?.slice(0, 100);
      const lastMsg = customerMessages[customerMessages.length - 1]?.slice(0, 100);
      summary = `Conversation with ${customerMessages.length} customer message(s). Started with: "${firstMsg}". Ended with: "${lastMsg}"`;
    }

    // Suggest follow-up
    let suggestedFollowUp: string | undefined;
    if (sentimentResult.sentiment === 'negative') {
      suggestedFollowUp = 'Check in with customer to resolve their concerns.';
    } else if (sentimentResult.sentiment === 'positive') {
      suggestedFollowUp = 'Customer is satisfied. Consider asking for a testimonial or referral.';
    }

    return {
      summary,
      keyPoints: keyPoints.slice(0, 3),
      sentiment: sentimentResult.sentiment,
      suggestedFollowUp,
    };
  }
}
