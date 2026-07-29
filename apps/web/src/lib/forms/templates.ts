import type { PublicFormField } from '@/components/forms/form-renderer';

export type FormTemplateSlug =
  | 'lead_capture'
  | 'contact_us'
  | 'feedback_survey'
  | 'webinar_registration'
  | 'newsletter_signup';

export interface FormTemplateDefinition {
  slug: FormTemplateSlug;
  name: string;
  description: string;
  iconName: 'UserPlus' | 'MessageSquare' | 'Star' | 'Calendar' | 'Mail';
  fields: PublicFormField[];
  settings?: {
    submit_label?: string;
    success_message?: string;
  };
}

export const FORM_TEMPLATES: Record<FormTemplateSlug, FormTemplateDefinition> = {
  lead_capture: {
    slug: 'lead_capture',
    name: 'Lead Capture',
    description: 'Collect contact details and project info from potential customers.',
    iconName: 'UserPlus',
    settings: {
      submit_label: 'Get in Touch',
      success_message: 'Thanks for reaching out! A member of our team will contact you shortly.',
    },
    fields: [
      {
        field_key: 'heading_1',
        type: 'heading',
        label: 'Contact Information',
      },
      {
        field_key: 'full_name',
        type: 'text',
        label: 'Full Name',
        placeholder: 'John Doe',
        required: true,
        width: 'half',
      },
      {
        field_key: 'email',
        type: 'email',
        label: 'Work Email',
        placeholder: 'john@company.com',
        required: true,
        width: 'half',
      },
      {
        field_key: 'phone',
        type: 'phone',
        label: 'Phone Number',
        placeholder: '+1 (555) 000-0000',
        required: false,
        width: 'half',
      },
      {
        field_key: 'company',
        type: 'text',
        label: 'Company Name',
        placeholder: 'Acme Inc.',
        required: false,
        width: 'half',
      },
      {
        field_key: 'message',
        type: 'textarea',
        label: 'How can we help you?',
        placeholder: 'Tell us a bit about your project or inquiry...',
        required: true,
        width: 'full',
      },
    ],
  },

  contact_us: {
    slug: 'contact_us',
    name: 'Contact Us',
    description: 'General inquiry form for support, sales, or general questions.',
    iconName: 'MessageSquare',
    settings: {
      submit_label: 'Send Message',
      success_message: 'Thank you for your message. We will respond within 24 hours.',
    },
    fields: [
      {
        field_key: 'name',
        type: 'text',
        label: 'Your Name',
        placeholder: 'Jane Smith',
        required: true,
        width: 'half',
      },
      {
        field_key: 'email',
        type: 'email',
        label: 'Email Address',
        placeholder: 'jane@example.com',
        required: true,
        width: 'half',
      },
      {
        field_key: 'inquiry_type',
        type: 'select',
        label: 'What is this regarding?',
        required: true,
        width: 'full',
        options: [
          { value: 'sales', label: 'Sales & Pricing' },
          { value: 'support', label: 'Technical Support' },
          { value: 'billing', label: 'Billing & Account' },
          { value: 'general', label: 'General Question' },
        ],
      },
      {
        field_key: 'subject',
        type: 'text',
        label: 'Subject',
        placeholder: 'Brief summary of your request',
        required: true,
        width: 'full',
      },
      {
        field_key: 'details',
        type: 'textarea',
        label: 'Message',
        placeholder: 'Provide any extra details here...',
        required: true,
        width: 'full',
      },
    ],
  },

  feedback_survey: {
    slug: 'feedback_survey',
    name: 'Customer Feedback',
    description: 'Gather rating and qualitative feedback from your users.',
    iconName: 'Star',
    settings: {
      submit_label: 'Submit Feedback',
      success_message: 'Thank you for your feedback! Your opinion helps us improve.',
    },
    fields: [
      {
        field_key: 'heading_feedback',
        type: 'heading',
        label: 'We value your opinion',
      },
      {
        field_key: 'rating',
        type: 'rating',
        label: 'How satisfied are you with our product or service?',
        scale: 5,
        required: true,
      },
      {
        field_key: 'likes',
        type: 'textarea',
        label: 'What did you like most?',
        placeholder: 'Features, support, ease of use...',
        required: false,
      },
      {
        field_key: 'improvements',
        type: 'textarea',
        label: 'What can we do to improve?',
        placeholder: 'Suggestions or features you would like to see...',
        required: false,
      },
      {
        field_key: 'can_contact',
        type: 'consent',
        label: 'We may contact you to follow up on your feedback.',
        required: false,
      },
    ],
  },

  webinar_registration: {
    slug: 'webinar_registration',
    name: 'Event / Webinar RSVP',
    description: 'Register attendees for upcoming webinars, workshops, or events.',
    iconName: 'Calendar',
    settings: {
      submit_label: 'Register Now',
      success_message: 'You are registered! Check your inbox for calendar invite & link.',
    },
    fields: [
      {
        field_key: 'name',
        type: 'text',
        label: 'Full Name',
        placeholder: 'Alex Johnson',
        required: true,
        width: 'half',
      },
      {
        field_key: 'email',
        type: 'email',
        label: 'Email Address',
        placeholder: 'alex@company.com',
        required: true,
        width: 'half',
      },
      {
        field_key: 'topics',
        type: 'multiselect',
        label: 'Which topics are you most interested in?',
        required: false,
        options: [
          { value: 'product_demo', label: 'Live Product Demo' },
          { value: 'best_practices', label: 'Industry Best Practices' },
          { value: 'qa_session', label: 'Live Q&A with Experts' },
        ],
      },
      {
        field_key: 'questions',
        type: 'textarea',
        label: 'Questions for the speaker',
        placeholder: 'Anything specific you want us to cover?',
        required: false,
      },
    ],
  },

  newsletter_signup: {
    slug: 'newsletter_signup',
    name: 'Newsletter Signup',
    description: 'Simple email subscription form for updates and newsletters.',
    iconName: 'Mail',
    settings: {
      submit_label: 'Subscribe',
      success_message: 'Thanks for subscribing! Please check your email to confirm.',
    },
    fields: [
      {
        field_key: 'email',
        type: 'email',
        label: 'Email Address',
        placeholder: 'you@domain.com',
        required: true,
      },
      {
        field_key: 'interests',
        type: 'multiselect',
        label: 'Topics of interest',
        required: false,
        options: [
          { value: 'weekly_digest', label: 'Weekly Product Digest' },
          { value: 'special_offers', label: 'Special Offers & Promotions' },
          { value: 'tech_updates', label: 'Developer & API Updates' },
        ],
      },
      {
        field_key: 'consent',
        type: 'consent',
        label: 'I agree to receive promotional emails. Unsubscribe anytime.',
        required: true,
      },
    ],
  },
};

export const FORM_TEMPLATE_ORDER: FormTemplateSlug[] = [
  'lead_capture',
  'contact_us',
  'feedback_survey',
  'webinar_registration',
  'newsletter_signup',
];
