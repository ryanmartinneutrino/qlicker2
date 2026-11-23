import { useEffect, useRef } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Container, Link, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getDashboardPath } from '../utils/dashboard';

export default function Privacy() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const headingRef = useRef(null);
  const sections = t('privacy.sections', { returnObjects: true });

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <Container component="main" maxWidth="sm" sx={{ py: { xs: 3, sm: 5 } }}>
      <Link component={RouterLink} to={user ? getDashboardPath(user) : '/'}>
        {t(user ? 'nav.goToDashboard' : 'auth.goToLandingPage')}
      </Link>
      <Typography component="h1" variant="h4" ref={headingRef} tabIndex={-1} sx={{ mt: 3, mb: 2, outline: 'none' }}>
        {t('privacy.title')}
      </Typography>
      <Typography>{t('privacy.intro')}</Typography>
      {sections.map((section, index) => (
        <Box component="section" key={index} aria-labelledby={`privacy-section-${index}`} sx={{ mt: 3 }}>
          <Typography component="h2" variant="h6" id={`privacy-section-${index}`} gutterBottom>
            {section.title}
          </Typography>
          <Typography sx={{ lineHeight: 1.7 }}>{section.body}</Typography>
        </Box>
      ))}
    </Container>
  );
}
