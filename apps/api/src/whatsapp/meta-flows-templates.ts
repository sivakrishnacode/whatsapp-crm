/**
 * Starter Flow JSON templates for native Meta WhatsApp Flows.
 *
 * These mirror the categories users see in Business Manager (appointment
 * booking, survey, feedback, lead-gen, contact us) so they get a working
 * starting point instead of a blank editor. Each `flowJson` is a valid,
 * self-contained (no data-endpoint) Flow JSON that a user can then edit;
 * Meta re-validates it on save/publish.
 *
 * `flowJson` is stored as an object and stringified when handed to Meta or
 * the editor — see `getMetaFlowTemplate` / the controller's templates route.
 */

import type { MetaFlowCategory } from './meta-flows-api.util';

export interface MetaFlowTemplate {
  id: string;
  name: string;
  category: MetaFlowCategory;
  description: string;
  flowJson: Record<string, unknown>;
}

const FLOW_VERSION = '5.0';

const APPOINTMENT_BOOKING: Record<string, unknown> = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'APPOINTMENT',
      title: 'Book an appointment',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Book your appointment' },
          {
            type: 'TextBody',
            text: 'Tell us when works for you and we will confirm.',
          },
          {
            type: 'Form',
            name: 'appointment_form',
            children: [
              {
                type: 'TextInput',
                name: 'full_name',
                label: 'Full name',
                'input-type': 'text',
                required: true,
              },
              {
                type: 'TextInput',
                name: 'phone',
                label: 'Phone number',
                'input-type': 'phone',
                required: true,
              },
              {
                type: 'DatePicker',
                name: 'preferred_date',
                label: 'Preferred date',
                required: true,
              },
              {
                type: 'Dropdown',
                name: 'service',
                label: 'Service',
                required: true,
                'data-source': [
                  { id: 'consultation', title: 'Consultation' },
                  { id: 'follow_up', title: 'Follow-up' },
                  { id: 'demo', title: 'Product demo' },
                ],
              },
              {
                type: 'Footer',
                label: 'Confirm booking',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    full_name: '${form.full_name}',
                    phone: '${form.phone}',
                    preferred_date: '${form.preferred_date}',
                    service: '${form.service}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const CUSTOMER_SURVEY: Record<string, unknown> = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'SURVEY',
      title: 'Quick survey',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'We would love your feedback' },
          {
            type: 'Form',
            name: 'survey_form',
            children: [
              {
                type: 'RadioButtonsGroup',
                name: 'satisfaction',
                label: 'How satisfied are you?',
                required: true,
                'data-source': [
                  { id: 'very_satisfied', title: 'Very satisfied' },
                  { id: 'satisfied', title: 'Satisfied' },
                  { id: 'neutral', title: 'Neutral' },
                  { id: 'unsatisfied', title: 'Unsatisfied' },
                ],
              },
              {
                type: 'Dropdown',
                name: 'recommend',
                label: 'Would you recommend us?',
                required: true,
                'data-source': [
                  { id: 'yes', title: 'Yes' },
                  { id: 'maybe', title: 'Maybe' },
                  { id: 'no', title: 'No' },
                ],
              },
              {
                type: 'TextArea',
                name: 'comments',
                label: 'Any comments?',
                required: false,
              },
              {
                type: 'Footer',
                label: 'Submit',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    satisfaction: '${form.satisfaction}',
                    recommend: '${form.recommend}',
                    comments: '${form.comments}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const FEEDBACK: Record<string, unknown> = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'FEEDBACK',
      title: 'Send feedback',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Share your feedback' },
          {
            type: 'Form',
            name: 'feedback_form',
            children: [
              {
                type: 'RadioButtonsGroup',
                name: 'rating',
                label: 'Rate your experience',
                required: true,
                'data-source': [
                  { id: '5', title: '★★★★★ Excellent' },
                  { id: '4', title: '★★★★ Good' },
                  { id: '3', title: '★★★ Average' },
                  { id: '2', title: '★★ Poor' },
                  { id: '1', title: '★ Very poor' },
                ],
              },
              {
                type: 'TextArea',
                name: 'message',
                label: 'Tell us more',
                required: true,
              },
              {
                type: 'Footer',
                label: 'Send feedback',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    rating: '${form.rating}',
                    message: '${form.message}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const LEAD_GENERATION: Record<string, unknown> = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'LEAD',
      title: 'Get in touch',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Tell us about your interest' },
          {
            type: 'TextBody',
            text: 'Leave your details and our team will reach out.',
          },
          {
            type: 'Form',
            name: 'lead_form',
            children: [
              {
                type: 'TextInput',
                name: 'full_name',
                label: 'Full name',
                'input-type': 'text',
                required: true,
              },
              {
                type: 'TextInput',
                name: 'email',
                label: 'Email',
                'input-type': 'email',
                required: true,
              },
              {
                type: 'TextInput',
                name: 'company',
                label: 'Company',
                'input-type': 'text',
                required: false,
              },
              {
                type: 'Dropdown',
                name: 'interest',
                label: "I'm interested in",
                required: true,
                'data-source': [
                  { id: 'pricing', title: 'Pricing' },
                  { id: 'demo', title: 'A demo' },
                  { id: 'partnership', title: 'Partnership' },
                  { id: 'other', title: 'Something else' },
                ],
              },
              {
                type: 'Footer',
                label: 'Submit',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    full_name: '${form.full_name}',
                    email: '${form.email}',
                    company: '${form.company}',
                    interest: '${form.interest}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const CONTACT_US: Record<string, unknown> = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'CONTACT',
      title: 'Contact us',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'How can we help?' },
          {
            type: 'Form',
            name: 'contact_form',
            children: [
              {
                type: 'TextInput',
                name: 'full_name',
                label: 'Your name',
                'input-type': 'text',
                required: true,
              },
              {
                type: 'Dropdown',
                name: 'topic',
                label: 'Topic',
                required: true,
                'data-source': [
                  { id: 'sales', title: 'Sales' },
                  { id: 'support', title: 'Support' },
                  { id: 'billing', title: 'Billing' },
                  { id: 'other', title: 'Other' },
                ],
              },
              {
                type: 'TextArea',
                name: 'message',
                label: 'Message',
                required: true,
              },
              {
                type: 'Footer',
                label: 'Send',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    full_name: '${form.full_name}',
                    topic: '${form.topic}',
                    message: '${form.message}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const BLANK: Record<string, unknown> = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'WELCOME_SCREEN',
      title: 'Welcome',
      terminal: true,
      success: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: 'Hello World' },
          {
            type: 'Footer',
            label: 'Complete',
            'on-click-action': { name: 'complete', payload: {} },
          },
        ],
      },
    },
  ],
};

export const META_FLOW_TEMPLATES: MetaFlowTemplate[] = [
  {
    id: 'appointment_booking',
    name: 'Appointment booking',
    category: 'APPOINTMENT_BOOKING',
    description:
      'Let customers pick a date and service, then confirm the booking.',
    flowJson: APPOINTMENT_BOOKING,
  },
  {
    id: 'customer_survey',
    name: 'Customer survey',
    category: 'SURVEY',
    description: 'Collect satisfaction ratings and open-ended comments.',
    flowJson: CUSTOMER_SURVEY,
  },
  {
    id: 'feedback',
    name: 'Feedback',
    category: 'SURVEY',
    description: 'A quick star rating plus a free-text message.',
    flowJson: FEEDBACK,
  },
  {
    id: 'lead_generation',
    name: 'Lead generation',
    category: 'LEAD_GENERATION',
    description: 'Capture name, email, company and interest for follow-up.',
    flowJson: LEAD_GENERATION,
  },
  {
    id: 'contact_us',
    name: 'Contact us',
    category: 'CONTACT_US',
    description: 'Route enquiries by topic with a message field.',
    flowJson: CONTACT_US,
  },
  {
    id: 'blank',
    name: 'Blank',
    category: 'OTHER',
    description: 'A minimal single-screen flow to build on from scratch.',
    flowJson: BLANK,
  },
];

/** Look up a starter template by id. */
export function getMetaFlowTemplate(id: string): MetaFlowTemplate | undefined {
  return META_FLOW_TEMPLATES.find((t) => t.id === id);
}
