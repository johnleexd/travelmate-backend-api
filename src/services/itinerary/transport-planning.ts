/** Route speeds are explicit planning assumptions, never provider route/fare claims. */
export function transportPlanning(preference='') {
  if (/taxi|ride.?hailing|private|rental|car/i.test(preference)) return {mode:preference,speed:20,label:'selected road transport at an assumed 20 km/h',shared:true};
  if (/bus|train|metro|rail|public|jeepney|transit/i.test(preference)) return {mode:preference,speed:15,label:'selected public transport at an assumed 15 km/h',shared:false};
  if (/cycl|bik/i.test(preference)) return {mode:preference,speed:12,label:'selected cycling at an assumed 12 km/h',shared:false};
  return {mode:preference || 'walking transfer assumption',speed:4,label:/walk/i.test(preference)?'selected walking at 4 km/h':'walking at 4 km/h until the selected route/mode is confirmed',shared:false};
}
