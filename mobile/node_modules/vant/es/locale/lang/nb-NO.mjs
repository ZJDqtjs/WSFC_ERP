var stdin_default = {
  name: "Navn",
  tel: "Telefon",
  save: "Lagre",
  clear: "T\xF8m",
  undo: "Angre",
  cancel: "Avbryt",
  confirm: "Bekreft",
  delete: "Slett",
  loading: "Laster...",
  noCoupon: "Ingen kuponger",
  nameEmpty: "Vennligst fyll inn navn",
  addContact: "Legg til ny kontakt",
  telInvalid: "Ugyldig telefonnummer",
  vanCalendar: {
    end: "Slutt",
    start: "Start",
    title: "Kalender",
    weekdays: ["S\xF8n", "Man", "Tir", "Ons", "Tor", "Fre", "L\xF8r"],
    monthTitle: (year, month) => `${year}/${month}`,
    rangePrompt: (maxRange) => `Maks. ${maxRange} dager`
  },
  vanCascader: {
    select: "Velg"
  },
  vanPagination: {
    prev: "Forrige",
    next: "Neste"
  },
  vanPullRefresh: {
    pulling: "Dra for \xE5 oppdatere...",
    loosing: "Slipp for \xE5 oppdatere..."
  },
  vanSubmitBar: {
    label: "Totalt:"
  },
  vanCoupon: {
    unlimited: "Ubegrenset",
    discount: (discount) => `${discount * 10}% avslag`,
    condition: (condition) => `Minst ${condition}`
  },
  vanCouponCell: {
    title: "Kupong",
    count: (count) => `Du har ${count} kuponger`
  },
  vanCouponList: {
    exchange: "Bytt",
    close: "Lukk",
    enable: "Tilgjengelig",
    disabled: "Utilgjengelig",
    placeholder: "Kupongkode"
  },
  vanAddressEdit: {
    area: "Omr\xE5de",
    areaEmpty: "Vennligst velg omr\xE5de",
    addressEmpty: "Adressen kan ikke v\xE6re tom",
    addressDetail: "Adresse",
    defaultAddress: "Sett som standardadresse"
  },
  vanAddressList: {
    add: "Legg til ny adresse"
  }
};
export {
  stdin_default as default
};
