// Function to calculate the Haversine distance between two points
function haversineDistance(coord1, coord2) {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = (coord2.latitude - coord1.latitude) * (Math.PI / 180);
  const dLon = (coord2.longitude - coord1.longitude) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(coord1.latitude * (Math.PI / 180)) *
    Math.cos(coord2.latitude * (Math.PI / 180)) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in kilometers
  return distance;
}

// Function to cluster locations within a maximum distance of 20km
function clusterLocations(locations) {
  const clusters = [];

  locations.forEach((location) => {
    let addedToCluster = false;

    // Try to add the location to an existing cluster
    for (const cluster of clusters) {
      const center = cluster[0]; // Use the first location in the cluster as the center
      const distance = haversineDistance(center, location);

      if (distance <= 20) {
        cluster.push(location);
        addedToCluster = true;
        break;
      }
    }

    // If not added to any existing cluster, create a new cluster
    if (!addedToCluster) {
      clusters.push([location]);
    }
  });

  return clusters;
}

const locations = [
  { latitude: 40.7128, longitude: -74.0060 }, // New York City, USA
  { latitude: 40.7168, longitude: -74.0160 }, // New York City, USA
  { latitude: 40.7138, longitude: -74.0000 }, // New York City, USA
  { latitude: 34.0522, longitude: -118.2437 }, // Los Angeles, USA
  { latitude: 51.5074, longitude: -0.1278 }, // London, UK
  { latitude: 48.8566, longitude: 2.3522 }, // Paris, France
  { latitude: 35.6895, longitude: 139.6917 }, // Tokyo, Japan
  { latitude: -33.8688, longitude: 151.2093 }, // Sydney, Australia
  { latitude: -23.5505, longitude: -46.6333 }, // Sao Paulo, Brazil
  { latitude: 55.7558, longitude: 37.6176 }, // Moscow, Russia
  { latitude: 19.0760, longitude: 72.8777 }, // Mumbai, India
  { latitude: 31.2304, longitude: 121.4737 }, // Shanghai, China
];

const resultClusters = clusterLocations(locations);
console.log(resultClusters);

