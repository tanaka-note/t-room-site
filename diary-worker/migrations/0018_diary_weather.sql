ALTER TABLE diary_entries ADD COLUMN weather TEXT DEFAULT NULL
  CHECK (weather IS NULL OR weather IN (
    'sunny', 'cloudy', 'partly_cloudy', 'cloudy_rain',
    'rain', 'heavy_rain', 'thunder', 'snow'
  ));
